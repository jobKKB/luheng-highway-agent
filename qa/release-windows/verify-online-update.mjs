/** Real installed-app update consumer; fixture creation uses the shipped renderer bridge. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { appendFile, lstat, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function validatePair(pair) {
  assert.equal(pair.schema, 'luheng-online-update/v1');
  assert.equal(pair.repository, 'jobKKB/luheng-highway-agent');
  assert.equal(pair.feed, 'https://apps.luotuai.me/updates/windows/');
  assert.equal(pair.from.version, '0.7.0');
  assert.equal(pair.to.version, '0.7.1');
  for (const entry of [pair.from, pair.to]) {
    assert.match(entry.sha256, /^[a-f0-9]{64}$/);
    assert.ok(Number.isSafeInteger(entry.bytes) && entry.bytes > 0);
    assert.match(entry.exeSha256, /^[a-f0-9]{64}$/);
    assert.match(entry.asarSha256, /^[a-f0-9]{64}$/);
  }
  for (const entry of [pair.from, pair.to]) {
    const url = new URL(entry.url);
    assert.equal(url.origin, 'https://github.com');
    assert.equal(url.username + url.password + url.search + url.hash, '');
    const prefix = `/jobKKB/luheng-highway-agent/releases/download/v${entry.version}-beta.1/`;
    assert.ok(url.pathname.startsWith(prefix));
    assert.match(url.pathname.slice(prefix.length), /^[A-Za-z0-9._-]+\.exe$/);
  }
  return pair;
}

export function within(root, target) {
  const relative = path.win32.relative(root, target);
  return relative !== '' && !path.win32.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..\\');
}

export function verifyStages(events) {
  const stages = events.map(row => row.stage);
  let previous = -1;
  for (const stage of ['fetch', 'prepare', 'restart']) {
    const index = stages.indexOf(stage, previous + 1);
    assert.ok(index > previous, `Missing or out-of-order product update stage: ${stage}`);
    previous = index;
  }
  assert.ok(!stages.includes('error'), 'Product reported update failure');
}

async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function main() {
  const args = process.argv.slice(2);
  assert.equal(args.length, 3, 'Expected phase, runtime lock, and dependency package.json');
  const [phase, lockPath, dependencyPackage] = args;
  assert.ok(['handoff', 'verify'].includes(phase));
  assert.equal(process.platform, 'win32');
  const runtime = JSON.parse(await readFile(lockPath, 'utf8'));
  const pair = validatePair(runtime.pair);
  for (const value of [runtime.exe, runtime.state, runtime.project, runtime.evidence]) {
    assert.ok(path.isAbsolute(value));
    assert.ok(within(runtime.job, value), 'Runtime path escaped the owned job');
  }
  assert.equal(process.env.GITHUB_ACTIONS, 'true');
  assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
  assert.equal(runtime.profileMode, 'fresh-disposable-default');
  assert.equal(runtime.home.toLowerCase(), path.join(process.env.LOCALAPPDATA, 'luheng-agent').toLowerCase());
  assert.equal(runtime.userData.toLowerCase(), path.join(process.env.APPDATA, 'luheng-agent-desktop').toLowerCase());
  for (const file of [runtime.exe, path.join(path.dirname(runtime.exe), 'resources/app.asar')]) {
    assert.ok(!(await lstat(file)).isSymbolicLink());
    assert.equal((await realpath(file)).toLowerCase(), path.resolve(file).toLowerCase());
  }
  const expected = phase === 'handoff' ? pair.from : pair.to;
  assert.equal(await digest(runtime.exe), expected.exeSha256);
  assert.equal(await digest(path.join(path.dirname(runtime.exe), 'resources/app.asar')), expected.asarSha256);
  const require = createRequire(path.resolve(dependencyPackage));
  const { _electron } = require('playwright');
  const evidence = async (name, data) => {
    const target = path.join(runtime.evidence, name);
    await writeFile(target + '.writing', JSON.stringify(data, null, 2));
    await rename(target + '.writing', target);
  };
  let app;
  const report = { schema: 1, phase, status: 'failed', version: expected.version, syntheticFixture: true };
  try {
    app = await _electron.launch({ executablePath: runtime.exe, args: [], timeout: 120000,
      cwd: runtime.project, env: { ...process.env } });
    const page = await app.firstWindow();
    const actual = await app.evaluate(({ app }) => ({ version: app.getVersion(), packaged: app.isPackaged,
      userData: app.getPath('userData'), homeOverride: process.env.HERMES_HOME,
      sandboxDisabled: app.commandLine.hasSwitch('no-sandbox') }));
    assert.equal(actual.version, expected.version);
    assert.equal(actual.packaged, true);
    assert.equal(actual.sandboxDisabled, false);
    assert.equal(path.resolve(actual.userData).toLowerCase(), path.resolve(runtime.userData).toLowerCase());
    assert.equal(actual.homeOverride, undefined);
    await page.waitForFunction(() => Boolean(window.hermesDesktop?.updates?.check && window.hermesDesktop?.api));
    await page.evaluate(() => window.hermesDesktop.getConnection());
    const api = request => page.evaluate(value => window.hermesDesktop.api(value), request);
    const health = await api({ path: '/api/health' });
    assert.equal(health.ok, true);
    assert.equal(health.version, expected.version);
    report.backendVersion = health.version;
    if (phase === 'handoff') {
      // Fresh profiles legitimately defer provider setup; use the actual product
      // action so the normal persisted preference must survive the update too.
      const chooseLater = page.getByRole('button', { name: /^(稍后再选择提供方|I'll choose a provider later)$/ });
      await chooseLater.waitFor({ state: 'visible', timeout: 120000 });
      const label = await chooseLater.innerText();
      await chooseLater.click();
      await chooseLater.waitFor({ state: 'hidden', timeout: 15000 });
      await evidence('provider-setup.json', { action: 'choose-provider-later', label, clicked: true, stateWrittenByProduct: true });
      report.onboardingDeferredViaUI = true;
      const marker = 'online-update-' + randomUUID();
      const id = 'update_' + randomUUID().replaceAll('-', '');
      await page.evaluate(project => window.hermesDesktop.settings.setDefaultProjectDir(project), runtime.project);
      const imported = await api({ path: '/api/sessions/import', method: 'POST', body: { sessions: [{
        id, source: 'cli', title: marker, pinned: true, started_at: Date.now() / 1000,
        // A completed synthetic exchange avoids resuming an unfinished model turn.
        ended_at: Date.now() / 1000, messages: [{ role: 'user', content: marker },
          { role: 'assistant', content: 'Synthetic fixture acknowledgement: ' + marker }]
      }] } });
      assert.equal(imported.ok, true);
      assert.equal(imported.imported, 1);
      const session = await api({ path: `/api/sessions/${id}` });
      const messages = await api({ path: `/api/sessions/${id}/messages` });
      assert.ok(JSON.stringify(session).includes(marker));
      assert.ok(JSON.stringify(messages).includes(marker));
      const markerPath = path.join(runtime.project, 'retained-marker.txt');
      await writeFile(markerPath, marker);
      await evidence('fixture.json', { id, marker, markerPath, markerSha256: await digest(markerPath), project: runtime.project });
      const status = await page.evaluate(() => window.hermesDesktop.updates.check({ force: true }));
      assert.equal(status.supported, true);
      assert.equal(status.currentVersion, pair.from.version);
      assert.equal(status.updateAvailable, true);
      assert.equal(status.latestTag, 'v' + pair.to.version);
      await evidence('check-before.json', status);
      const events = [];
      let writes = Promise.resolve();
      await page.exposeFunction('recordOwnedUpdateProgress', event => {
        events.push(event);
        writes = writes.then(() => appendFile(path.join(runtime.evidence, 'progress.jsonl'), JSON.stringify(event) + '\n'));
        return writes;
      });
      await page.evaluate(() => window.hermesDesktop.updates.onProgress(event => window.recordOwnedUpdateProgress(event)));
      await evidence('baseline-ready.json', { pid: app.process().pid, exe: runtime.exe, exeSha256: expected.exeSha256 });
      await page.screenshot({ path: path.join(runtime.evidence, 'baseline.png') });
      const closed = new Promise(resolve => app.once('close', resolve));
      const applying = page.evaluate(() => window.hermesDesktop.updates.apply({})).catch(error => ({ transportClosed: error.message }));
      await Promise.race([closed, new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error('Product did not exit for its real installer')), 1200000);
        timer.unref();
      })]);
      await writes;
      await applying;
      verifyStages(events);
      app = null;
      report.status = 'product-handoff-observed';
      report.downloadedByProduct = true;
      report.installationVerified = false;
    } else {
      const fixture = JSON.parse(await readFile(path.join(runtime.evidence, 'fixture.json'), 'utf8'));
      assert.equal((await page.evaluate(() => window.hermesDesktop.settings.getDefaultProjectDir())).dir, fixture.project);
      const session = await api({ path: `/api/sessions/${fixture.id}` });
      const messages = await api({ path: `/api/sessions/${fixture.id}/messages` });
      assert.ok(JSON.stringify(session).includes(fixture.marker));
      assert.ok(JSON.stringify(messages).includes(fixture.marker));
      assert.equal(await digest(fixture.markerPath), fixture.markerSha256);
      const status = await page.evaluate(() => window.hermesDesktop.updates.check({ force: true }));
      assert.equal(status.supported, true);
      assert.equal(status.currentVersion, pair.to.version);
      assert.equal(status.updateAvailable, false);
      assert.ok(!status.error);
      await evidence('check-after.json', status);
      await page.screenshot({ path: path.join(runtime.evidence, 'target.png') });
      report.status = 'target-and-data-verified';
      report.settingsSessionAndFileRetained = true;
    }
  } catch (error) {
    report.error = error.message;
    await evidence(`renderer-${phase}.json`, report);
    process.exitCode = 1;
  } finally {
    if (app) await app.close();
    await evidence(`renderer-${phase}.json`, report);
  }
}

if (process.argv[2] === '--self-test') {
  const entry = { bytes: 1, sha256: 'a'.repeat(64), exeSha256: 'b'.repeat(64), asarSha256: 'c'.repeat(64) };
  const pair = { schema: 'luheng-online-update/v1', repository: 'jobKKB/luheng-highway-agent', feed: 'https://apps.luotuai.me/updates/windows/',
    from: { ...entry, version: '0.7.0', url: 'https://github.com/jobKKB/luheng-highway-agent/releases/download/v0.7.0-beta.1/Luheng.exe' }, to: { ...entry, version: '0.7.1',
      url: 'https://github.com/jobKKB/luheng-highway-agent/releases/download/v0.7.1-beta.1/Luheng.exe' } };
  validatePair(pair);
  for (const url of ['https://evil.example/Luheng.exe', pair.to.url + '?redirect=1', pair.to.url.replace('jobKKB', 'other')])
    assert.throws(() => validatePair({ ...pair, to: { ...pair.to, url } }));
  assert.throws(() => validatePair({ ...pair, to: { ...pair.to, version: '0.7.0' } }));
  assert.ok(within('C:\\owned', 'C:\\owned\\state'));
  for (const value of ['C:\\owned', 'C:\\owned-other\\state', 'C:\\owned\\..\\other', 'D:\\state'])
    assert.equal(within('C:\\owned', value), false);
  verifyStages([{ stage: 'fetch' }, { stage: 'prepare' }, { stage: 'restart' }]);
  assert.throws(() => verifyStages([{ stage: 'restart' }, { stage: 'fetch' }]));
  assert.throws(() => verifyStages([{ stage: 'fetch' }, { stage: 'prepare' }, { stage: 'restart' }, { stage: 'error' }]));
  console.log('Pair authority, exact versions, path boundaries, and progress-order self-tests passed');
} else if (process.argv[2] === '--validate-pair') {
  validatePair(JSON.parse(await readFile(process.argv[3], 'utf8')));
  console.log('Exact online update pair admitted');
} else if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
