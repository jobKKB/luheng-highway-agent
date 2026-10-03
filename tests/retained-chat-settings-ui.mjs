import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inflateRawSync } from 'node:zlib';

// Migrates retained UI contracts to the generic/API-first workspace. Ordinary
// application testing only: owned temporary data, no external network/provider,
// no real credentials/mail/business, actual CSS and sandboxed Chromium. Desktop
// integration below is explicitly a fake bridge, never evidence of OS storage,
// tray, a packaged desktop, installation, upgrade, or physical IME operation.
// --prepare-only does not listen on a socket or launch Chromium. It establishes
// positive service/fixture contracts, not a browser pass or a substitute for CI.
// All browser interactions use rendered controls/keyboard/file chooser. evaluate
// calls below READ DOM facts only; there are no forced clicks, requestSubmit,
// direct render/loadState calls, hidden product-variable writes or CSS overrides.

const argv = process.argv.slice(2), options = {};
for (let index = 0; index < argv.length; index++) {
  const arg = argv[index];
  if (arg === '--prepare-only' || arg === '--require-windows') options[arg.slice(2)] = true;
  else if (arg === '--source-root' || arg === '--output-dir') {
    assert.ok(argv[index + 1] && !argv[index + 1].startsWith('--'), arg + ' requires a path');
    options[arg.slice(2)] = argv[++index];
  } else throw new Error('Unknown argument: ' + arg);
}
if (options['require-windows']) assert.equal(process.platform, 'win32', 'This gate requires actual Windows');
const root = resolve(options['source-root'] || join(dirname(fileURLToPath(import.meta.url)), '..'));
const out = resolve(options['output-dir'] || await mkdtemp(join(tmpdir(), 'luheng-retained-proof-')));
const outputRelative = relative(root, out);
assert.ok(outputRelative && (outputRelative.startsWith('..') || isAbsolute(outputRelative)), 'Evidence must be outside the source tree');
await mkdir(out, { recursive: true });
const owned = await mkdtemp(join(tmpdir(), 'luheng-retained-owned-'));
const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
const moduleAt = path => import(pathToFileURL(join(root, path)).href);
async function loadChromium() {
  const require = createRequire(join(root, 'package.json'));
  const module = await import(pathToFileURL(require.resolve('playwright')).href);
  const chromium = module.chromium || module.default?.chromium;
  assert.equal(typeof chromium?.launch, 'function', 'Playwright Chromium API is loadable without launching');
  return chromium;
}
const [{ Store }, { Engine }, { SkillsService }, { ScheduleService }, office] = await Promise.all([
  moduleAt('lib/store.mjs'), moduleAt('lib/engine.mjs'), moduleAt('lib/skills.mjs'),
  moduleAt('lib/schedules.mjs'), moduleAt('lib/office-artifacts.mjs'),
]);
const ENDPOINT = 'https://8.8.8.8/v1'; // Public IP syntax; injected completion never contacts it.
const MODEL = 'synthetic-retained-ui-model';
const FAKE_KEY = 'SYNTHETIC_RETAINED_UI_KEY_NOT_REAL_20261003';
const ARTIFACT_MARKER = '[RETAINED_ARTIFACT]';
const ARTIFACT_TEXT = '# 通用合成资料\nThis document is owned synthetic retained UI test data.\n';
const SKILL = '---\nname: retained-synthetic-method\ndescription: Owned synthetic retained UI workflow\n---\nUse the supplied test data, then answer plainly.\n';
const providerCalls = [];
const summary = '# 合成资料已整理\n\n这是通用任务的合成验收结果，使用可下载文件核对。\n\n- 内容来自本轮明确的合成工具\n- 可分别生成 Word 和 Excel\n- 生成文件不会重新执行任务';
function call(name, args, id) { return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } }; }
async function syntheticCompletion(request) {
  const latest = request.messages.filter(item => item.role === 'user').at(-1)?.content || '';
  providerCalls.push({ latest, roles: request.messages.map(item => item.role), skill: request.messages.some(item => item.content?.includes('retained-synthetic-method')) });
  if (latest.includes(ARTIFACT_MARKER)) {
    if (!request.messages.some(item => item.role === 'tool' && item.tool_call_id === 'retained-save'))
      return { message: { role: 'assistant', content: '', tool_calls: [call('workspace_save', { name: '通用合成资料.txt', content: ARTIFACT_TEXT }, 'retained-save')] } };
    return { message: { role: 'assistant', content: '', tool_calls: [call('agent_finish', { status: 'completed', summary, claimType: 'action', evidenceToolCallIds: ['retained-save'] }, 'retained-finish')] } };
  }
  return { message: { role: 'assistant', content: '合成通用回复：' + latest } };
}
const report = {
  schemaVersion: 1, status: 'running', platform: process.platform, version,
  observedCICommit: process.env.GITHUB_SHA || null,
  driverSha256: createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex'),
  mode: options['prepare-only'] ? 'prepare-only' : 'actual-browser',
  sandbox: true, externalNetwork: false, realProviders: false, fakeDesktopBridge: true,
  scheduleTimer: false, fakeClock: false, screenshotOptions: { animations: 'allow', caret: 'initial' },
  preparation: [], checks: [], failures: [], screenshots: [], domFacts: [], pageErrors: [],
  plannedUIContracts: [
    'API-first unconfigured form and real Settings model configuration',
    'HTTP/network rejection, preserved chat draft, explicit retry with one submissionId',
    'Lost accepted response retries the same persisted task; identical new chat uses a new key',
    'Real double-click plus repeated Ctrl Enter cannot duplicate a pending submission',
    'Delayed task success/failure preserves newer drafts, Settings edits and task selection',
    'Keyboard new chat, Escape return focus and Back/Forward without stale modal revival',
    'Reminder validation, transport retry, Settings background draft and closed/reopened late responses',
    'Schedule timezone/weekdays, daily/weekly/interval, real-poll draft, edit/default role, pause/resume and two-step cancellation',
    'Real original/DOCX/XLSX downloads, independent OOXML/hash check, reload links and no model/task replay',
    'Explicit fake-desktop credential opt-in/reset/forget and unavailable storage/tray without plaintext fallback',
    'Standalone desktop controls absent; actual CSS/viewport fit at 1180x812, 1280x720, 1440x1000 and 1920x1080 at 2x',
  ],
  notCovered: [
    'Native packaged desktop OS encryption/tray and credential recovery; separate native probe required',
    'Installer, upgrade, signing, release or production readiness',
    'Mail and controlled-browser UI contracts; separate dedicated drivers',
    'Physical input-method hardware, IME composition, text Range and 60-second idle stability; existing dedicated gates',
    'Reminder firing, DST/catch-up timing and schedule execution; backend schedule tests',
    'Real model/network reachability, public web providers or actual business material',
    'Phone/mobile layout; existing generic-chat UI gate covers 360px',
    'Skills browser import/selection, generic Markdown and follow-up history; existing generic-chat UI gate',
  ],
};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await pause(60); }
  throw new Error('Timed out: ' + label);
}
async function bounded(promise, label, timeout = 20000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Timed out: ' + label)), timeout); })]); }
  finally { clearTimeout(timer); }
}
function preparation(name) { report.preparation.push(name); console.log('PREPARE PASS ' + name); }

// Independent ZIP structure reader. Browser exports must be actual OOXML bytes,
// rather than a filename check, a mocked response or a leading-PK-only claim.
function zipParts(buffer) {
  assert.equal(buffer.readUInt32LE(buffer.length - 22), 0x06054b50, 'OOXML end-of-central-directory');
  const count = buffer.readUInt16LE(buffer.length - 12);
  let cursor = buffer.readUInt32LE(buffer.length - 6);
  const parts = new Map();
  for (let index = 0; index < count; index++) {
    assert.equal(buffer.readUInt32LE(cursor), 0x02014b50);
    const method = buffer.readUInt16LE(cursor + 10), size = buffer.readUInt32LE(cursor + 20);
    const rawSize = buffer.readUInt32LE(cursor + 24), nameLength = buffer.readUInt16LE(cursor + 28);
    const extra = buffer.readUInt16LE(cursor + 30), comment = buffer.readUInt16LE(cursor + 32);
    const local = buffer.readUInt32LE(cursor + 42);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    assert.equal(buffer.readUInt32LE(local), 0x04034b50);
    const dataAt = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const packed = buffer.subarray(dataAt, dataAt + size);
    assert.ok(method === 0 || method === 8, 'Supported standard ZIP compression');
    const bytes = method === 8 ? inflateRawSync(packed) : packed;
    assert.equal(bytes.length, rawSize); assert.ok(!parts.has(name)); parts.set(name, bytes.toString('utf8'));
    cursor += 46 + nameLength + extra + comment;
  }
  assert.equal(cursor, buffer.length - 22); return parts;
}
function assertOffice(buffer, format) {
  const parts = zipParts(buffer);
  assert.ok(parts.has('[Content_Types].xml'));
  if (format === 'docx') { assert.ok(parts.has('word/document.xml')); assert.match(parts.get('[Content_Types].xml'), /wordprocessingml/); }
  else { assert.ok(parts.has('xl/workbook.xml')); assert.ok(parts.has('xl/worksheets/sheet1.xml')); assert.match(parts.get('[Content_Types].xml'), /spreadsheetml/); }
  return parts;
}
function narrowOwnedCoordinator(store) {
  // Only our owned fixture role is narrowed; production source/permissions are
  // unchanged. This focuses these tests on public/persistable UI results.
  store.put('agents', 'coordinator', { ...store.get('agents', 'coordinator'), permissions: ['knowledge.read', 'workspace.write', 'reminder.create'] });
}
async function prepareWithoutSockets() {
  const [serverSource, appSource, html] = await Promise.all([
    readFile(join(root, 'server.mjs'), 'utf8'), readFile(join(root, 'public/app.js'), 'utf8'), readFile(join(root, 'public/index.html'), 'utf8'),
  ]);
  assert.equal(version, '0.6.0-beta.1');
  for (const endpoint of ['/api/tasks', '/api/settings', '/api/schedules', '/api/desktop/preferences']) assert.ok(serverSource.includes(endpoint), endpoint + ' source endpoint exists');
  assert.ok(serverSource.includes('credentials\\/(save|forget)'), 'Regex desktop credential save/forget route exists');
  for (const id of ['task-form', 'schedule-form', 'reminder-form', 'desktop-credential-consent', 'desktop-save-credentials', 'settings-form']) assert.ok(appSource.includes(id), id + ' markup exists');
  assert.ok(appSource.includes('submissionId:submission.id')); assert.ok(appSource.includes('office-download'));
  for (const css of ['styles.css', 'ocean.css', 'chat.css']) { assert.ok(html.includes('/' + css)); assert.ok((await readFile(join(root, 'public', css))).length > 0); }
  await loadChromium();
  preparation('Candidate version, retained endpoint/markup shape and all real CSS assets');
  const dir = join(owned, 'prepare'), store = new Store(dir);
  const skills = new SkillsService(store); let engine, schedules;
  try {
    assert.equal(store.get('settings', 'main').mode, 'api'); assert.deepEqual(store.all('memories'), []);
    narrowOwnedCoordinator(store);
    store.put('settings', 'main', { ...store.get('settings', 'main'), mode: 'api', endpoint: ENDPOINT, model: MODEL, budget: 20 });
    const skill = skills.importPackage({ files: [{ path: 'SKILL.md', content: SKILL }] });
    assert.equal(skills.view(skill.id).readOnly, true);
    engine = new Engine(store, { close: async () => {} }, { delay: 1, getKey: () => FAKE_KEY, getSecrets: () => [FAKE_KEY], completion: syntheticCompletion, skillsService: skills });
    const input = { prompt: '请生成通用合成资料 ' + ARTIFACT_MARKER, agentId: 'coordinator', budget: 20, skillIds: [skill.id], submissionId: randomUUID() };
    const task = engine.create(input);
    assert.equal(engine.create(input).id, task.id); assert.equal(store.all('tasks').length, 1);
    const done = await until(() => { const value = engine.liveTask(task.id); return value.status === 'completed' && value; }, 'positive synthetic completion');
    assert.match(done.output, /合成资料/); assert.ok(done.artifact?.filename);
    assert.equal(await readFile(join(dir, 'artifacts', done.artifact.filename), 'utf8'), ARTIFACT_TEXT);
    assert.ok(providerCalls.some(item => item.skill));
    assert.equal(engine.create(input).id, done.id);
    preparation('Actual Engine + injected synthetic API + Skills + workspace file and one-task idempotency');
    const data = { title: '通用合成文档', summary: done.output, rows: [{ id: 'SYNTHETIC-01', task: '整理合成资料', status: 'completed', owner: '合成测试' }] };
    assertOffice(office.generateWeeklyReport(data), 'docx'); assertOffice(office.generateTaskWorkbook(data), 'xlsx');
    preparation('Real DOCX and XLSX OOXML writers produce inspectable packages');
    schedules = new ScheduleService(store, engine, { startTimer: false });
    const weekly = schedules.create({ title: '合成每周计划', prompt: '仅合成计划合同', agentId: 'coordinator', budget: 20, timezone: 'Asia/Shanghai', recurrence: { type: 'weekly', time: '09:30', daysOfWeek: [1, 5] } });
    assert.deepEqual(weekly.recurrence, { type: 'weekly', time: '09:30', daysOfWeek: [1, 5] });
    assert.equal(schedules.pause(weekly.id).status, 'paused'); assert.equal(schedules.resume(weekly.id).status, 'active');
    assert.equal(schedules.update(weekly.id, { title: '合成已编辑计划' }).title, '合成已编辑计划');
    assert.equal(schedules.cancel(weekly.id).status, 'cancelled');
    preparation('Actual schedule service weekly shape, edit, pause, resume and cancel');
    assert.ok(!JSON.stringify(store.get('settings', 'main')).includes(FAKE_KEY));
  } finally { schedules?.close(); await engine?.close(); store.close(); }
}

let app, standalone, browser;
const vault = { available: true, stored: false, backend: 'TEST ONLY in-memory fake bridge', reason: '' };
const desktop = { backgroundEnabled: false, trayAvailable: true };
let snapshot = null, saves = 0, forgets = 0;
const desktopBridge = {
  preferences: async () => ({ ...desktop }), status: async () => ({ ...vault }),
  setPreferences: async value => { desktop.backgroundEnabled = value.backgroundEnabled; },
  saveCredentials: async value => { assert.equal(vault.available, true); snapshot = structuredClone(value); saves++; vault.stored = true; },
  forgetCredentials: async () => { snapshot = null; forgets++; vault.stored = false; },
};
const submit = page => page.locator('#task-form [type="submit"]');
async function getState(page, target = app) {
  const response = await page.request.get(target.url + '/api/state'); assert.equal(response.status(), 200); return response.json();
}
async function ready(page) { await page.waitForFunction(() => loaded && online && !pollBusy && refreshWaiters.length === 0); }
async function settled(page) { await page.waitForFunction(() => !submitting && !pollBusy && refreshWaiters.length === 0); }
async function nav(page, name) {
  if (['schedules', 'agents', 'knowledge', 'mail', 'browser', 'audit'].includes(name) && await page.locator('#nav-tools').isHidden()) await page.locator('#nav [data-action="toggle-tools"]').click();
  await page.locator('#nav [data-nav="' + name + '"]').click();
  await page.locator('#main[data-view="' + name + '"]').waitFor(); await page.waitForURL('**/#' + name); await ready(page);
}
async function newChat(page) {
  await page.locator('.new-task-button').click(); await settled(page);
  await until(() => page.locator('#prompt-input').evaluate(node => node === document.activeElement), 'new chat focus');
}
async function terminal(page, id) {
  const task = await until(async () => { const value = (await getState(page)).tasks.find(task => task.id === id); return value && ['completed', 'failed', 'cancelled', 'needs_attention'].includes(value.status) && value; }, 'terminal task ' + id);
  assert.equal(task.status, 'completed', task.error || 'Synthetic task must complete'); await settled(page); return task;
}
async function sendTask(page, prompt) {
  await page.locator('#prompt-input').fill(prompt); assert.equal(await submit(page).isEnabled(), true);
  const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/tasks' && response.request().method() === 'POST');
  await submit(page).click(); const accepted = await response; assert.equal(accepted.status(), 201); const task = await accepted.json(); assert.ok(task.id); return terminal(page, task.id);
}
async function openReminder(page) {
  await page.locator('#notification-button').click();
  await page.locator('#modal-root [data-action="reminder"]').click(); await page.locator('#reminder-title').waitFor();
}
async function waitPolls(page, count = 2) {
  const start = page.__retainedStateReads;
  await until(() => page.__retainedStateReads >= start + count, 'actual background state polling', 9000);
  await settled(page);
}
async function screenshot(page, name) {
  const filename = name + '.png'; await page.screenshot({ path: join(out, filename), animations: 'allow', caret: 'initial' }); report.screenshots.push(filename);
}
async function holdPost(page, path, mode = 'accepted') {
  let release, entered, released = false; const payloads = [];
  const gate = new Promise(resolve => { release = () => { released = true; resolve(); }; });
  const seen = new Promise(resolve => { entered = resolve; });
  const matcher = '**' + path;
  const handler = async route => {
    if (route.request().method() !== 'POST') return route.continue();
    payloads.push(route.request().postDataJSON());
    const response = mode === 'accepted' ? await route.fetch() : null;
    if (response) assert.equal(response.status(), 201);
    entered(); await gate;
    if (response) await route.fulfill({ response });
    else await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'SYNTHETIC_RETAINED_SERVICE_UNAVAILABLE' }) });
  };
  await page.route(matcher, handler);
  return { seen, payloads, release, dispose: async () => { if (!released) release(); await page.unroute(matcher, handler); } };
}
async function browserStorage(page) {
  return page.evaluate(() => ({ local: Object.fromEntries(Object.keys(localStorage).map(key => [key, localStorage.getItem(key)])), session: Object.fromEntries(Object.keys(sessionStorage).map(key => [key, sessionStorage.getItem(key)])) }));
}
async function noSyntheticKeyInFiles(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await noSyntheticKeyInFiles(path);
    else if (entry.isFile()) assert.equal((await readFile(path)).includes(Buffer.from(FAKE_KEY)), false, 'Synthetic key must not fall back to plaintext file ' + entry.name);
  }
}
async function run(name, body, { target = app, viewport = { width: 1440, height: 1000 }, deviceScaleFactor = 1 } = {}) {
  let context, page;
  try {
    context = await browser.newContext({ viewport, deviceScaleFactor, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', acceptDownloads: true });
    const origin = new URL(target.url).origin;
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort('blockedbyclient'));
    page = await context.newPage(); page.__retainedStateReads = 0;
    page.on('response', response => { if (new URL(response.url()).pathname === '/api/state' && response.ok()) page.__retainedStateReads++; });
    page.on('pageerror', error => report.pageErrors.push({ name, message: error.message }));
    await page.goto(target.url); await ready(page);
    if (await page.locator('#local-access-form').isVisible()) {
      await page.locator('#local-access-form [data-action="local-defer"]').click(); await page.locator('.modal').waitFor({ state: 'hidden' }); await ready(page);
    }
    await page.locator('#prompt-input').waitFor(); await body(page);
    report.checks.push({ name, stateReads: page.__retainedStateReads }); console.log('PASS ' + name);
  } catch (error) {
    report.failures.push({ name, error: error.stack || error.message }); console.error('FAIL ' + name + '\n' + (error.stack || error.message));
    if (page) {
      try { await screenshot(page, 'failure-' + report.failures.length); } catch {}
      try { report.domFacts.push({ name, failure: true, facts: await page.evaluate(() => ({ view: document.querySelector('#main')?.dataset.view, focus: document.activeElement?.id, modal: !!document.querySelector('.modal'), width: innerWidth, scrollWidth: document.documentElement.scrollWidth })) }); } catch {}
    }
  } finally { await context?.close(); }
}

try {
  await prepareWithoutSockets();
  if (options['prepare-only']) {
    report.status = 'prepared-ui-not-run';
  } else {
    const { startServer } = await moduleAt('server.mjs');
    app = await startServer({ port: 0, dataDir: join(owned, 'app-data'), stepDelay: 1, completion: syntheticCompletion, desktopBridge, scheduleOptions: { startTimer: false } });
    standalone = await startServer({ port: 0, dataDir: join(owned, 'standalone-data'), stepDelay: 1, completion: syntheticCompletion, scheduleOptions: { startTimer: false } });
    narrowOwnedCoordinator(app.store); narrowOwnedCoordinator(standalone.store);
    const chromium = await loadChromium();
    browser = await chromium.launch({ headless: true, chromiumSandbox: true, executablePath: process.env.HIGHWAY_CHROMIUM_PATH || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined) });

    await run('API-first standalone shows no desktop credential controls or enabled send', async page => {
      assert.equal(await submit(page).isDisabled(), true);
      assert.equal(await page.locator('#nav-tools').isHidden(), true);
      assert.equal(await page.locator('#composer-options').isHidden(), true);
      assert.equal(await page.locator('.suggestion-card').count(), 0);
      await page.locator('#prompt-input').fill('未连接模型的合成草稿'); assert.equal(await submit(page).isDisabled(), true);
      await page.locator('.welcome [data-nav="settings"]').click(); await ready(page);
      assert.equal(await page.locator('#desktop-settings').count(), 0);
      assert.equal(await page.locator('#desktop-credential-consent').count(), 0);
      assert.match(await page.locator('#settings-form').innerText(), /仅保存在服务进程内存中/);
      const state = await getState(page, standalone);
      assert.equal(state.desktop.available, false); assert.equal(state.desktop.credentialVault.available, false);
      assert.equal(state.settings.credentialStorage, 'memory-only');
      await screenshot(page, 'standalone-settings-unavailable');
    }, { target: standalone });

    await run('Configure explicit synthetic model through retained Settings UI', async page => {
      assert.equal(await submit(page).isDisabled(), true); await nav(page, 'settings');
      await page.locator('#endpoint').fill(ENDPOINT); await page.locator('#model').fill(MODEL);
      await page.locator('#api-key').fill(FAKE_KEY); await page.locator('#budget').fill('20');
      await page.locator('#settings-form [type="submit"]').click();
      await until(async () => (await getState(page)).settings.hasApiKey, 'synthetic runtime key configured');
      await page.locator('#settings-status').filter({ hasText: '配置已保存' }).waitFor(); await ready(page);
      assert.equal(await page.locator('#api-key').inputValue(), ''); assert.equal(saves, 0);
      assert.equal(await page.locator('#desktop-credential-consent').isChecked(), false);
      assert.equal(await page.locator('#desktop-save-credentials').isDisabled(), true);
      const state = await getState(page); assert.equal(state.settings.mode, 'api'); assert.equal(state.settings.model, MODEL);
      assert.ok(!JSON.stringify(state).includes(FAKE_KEY));
      await nav(page, 'chat'); await page.locator('#prompt-input').fill('合成草稿'); assert.equal(await submit(page).isEnabled(), true);
      for (const css of ['styles.css', 'ocean.css', 'chat.css']) assert.equal((await page.request.get(app.url + '/' + css)).status(), 200);
    });

    for (const mode of ['http', 'network']) await run('Task ' + mode + ' failure retains draft and one explicit retry', async page => {
      const before = (await getState(page)).tasks.length, payloads = [];
      await page.route('**/api/tasks', async route => {
        if (route.request().method() !== 'POST') return route.continue(); payloads.push(route.request().postDataJSON());
        if (payloads.length > 1) return route.continue();
        if (mode === 'network') return route.abort('failed');
        return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'SYNTHETIC_RETAINED_TASK_FAILURE' }) });
      });
      const draft = '合成任务恢复 ' + mode; await page.locator('#prompt-input').fill(draft); await submit(page).click();
      await page.locator('#toast-root .toast.error').waitFor(); await settled(page);
      assert.equal(await submit(page).isEnabled(), true); assert.equal(await page.locator('#prompt-input').inputValue(), draft);
      assert.equal((await getState(page)).tasks.length, before);
      await submit(page).click(); await until(async () => (await getState(page)).tasks.length === before + 1, 'one explicit retry'); await settled(page);
      assert.equal(payloads.length, 2); assert.equal(payloads[1].submissionId, payloads[0].submissionId);
      await terminal(page, (await getState(page)).tasks.find(task => task.submissionId === payloads[0].submissionId).id);
      await waitPolls(page, 1); assert.equal((await getState(page)).tasks.length, before + 1);
    });

    await run('Lost accepted response reuses submissionId; identical new chat is independent', async page => {
      const before = (await getState(page)).tasks.length, payloads = [], ids = [];
      await page.route('**/api/tasks', async route => {
        if (route.request().method() !== 'POST') return route.continue(); payloads.push(route.request().postDataJSON());
        const accepted = await route.fetch(); assert.equal(accepted.status(), 201); ids.push((await accepted.json()).id);
        if (payloads.length === 1) return route.abort('failed'); return route.fulfill({ response: accepted });
      });
      const draft = '合成已接受响应丢失后的明确重试'; await page.locator('#prompt-input').fill(draft); await submit(page).click();
      await page.locator('#toast-root .toast.error').waitFor(); await settled(page);
      assert.equal(await page.locator('#prompt-input').inputValue(), draft); assert.equal(await submit(page).isEnabled(), true);
      assert.equal((await getState(page)).tasks.length, before + 1); await terminal(page, ids[0]);
      await submit(page).click(); await settled(page); await until(() => ids.length === 2, 'accepted retry response');
      assert.equal(payloads[1].submissionId, payloads[0].submissionId); assert.equal(ids[1], ids[0]);
      assert.equal((await getState(page)).tasks.length, before + 1);
      await newChat(page); assert.equal(await page.locator('.chat-turn').count(), 0);
      await page.locator('#prompt-input').fill(draft); await submit(page).click(); await settled(page);
      await until(() => ids.length === 3, 'intentional independent submission'); await terminal(page, ids[2]);
      assert.notEqual(payloads[2].submissionId, payloads[0].submissionId); assert.notEqual(ids[2], ids[0]);
      assert.equal((await getState(page)).tasks.length, before + 2);
    });

    await run('Held submission ignores real double-click and repeated Ctrl Enter gestures', async page => {
      const before = (await getState(page)).tasks.length, hold = await holdPost(page, '/api/tasks');
      try {
        await page.locator('#prompt-input').fill('合成真实双击与键盘重复提交'); await submit(page).dblclick(); await bounded(hold.seen, 'held duplicate-submit POST');
        assert.equal(await submit(page).isDisabled(), true);
        await page.locator('#prompt-input').click(); await page.keyboard.press('Control+Enter'); await page.keyboard.press('Control+Enter');
        await pause(180); assert.equal(hold.payloads.length, 1);
        hold.release(); await settled(page); await terminal(page, (await getState(page)).tasks.find(task => task.submissionId === hold.payloads[0].submissionId).id);
        assert.equal((await getState(page)).tasks.length, before + 1);
      } finally { await hold.dispose(); }
    });

    for (const mode of ['accepted', 'http']) await run('Delayed task ' + mode + ' preserves newer draft, Settings navigation and edits', async page => {
      const hold = await holdPost(page, '/api/tasks', mode);
      try {
        await page.locator('#prompt-input').fill('合成原始任务 ' + mode); await submit(page).click(); await bounded(hold.seen, 'held navigation POST');
        await page.locator('#prompt-input').fill('迟到响应不能覆盖这份新草稿'); await nav(page, 'settings');
        await page.locator('#model').fill('UNSAVED_RETAINED_SETTINGS_' + mode); hold.release();
        await page.locator('#toast-root .toast').filter({ hasText: mode === 'accepted' ? '任务已创建' : 'SYNTHETIC_RETAINED_SERVICE_UNAVAILABLE' }).waitFor();
        await settled(page); assert.equal(await page.locator('#settings-form').isVisible(), true);
        assert.equal(await page.locator('#model').inputValue(), 'UNSAVED_RETAINED_SETTINGS_' + mode);
        await nav(page, 'chat'); assert.equal(await page.locator('#prompt-input').inputValue(), '迟到响应不能覆盖这份新草稿');
        assert.equal(await submit(page).isEnabled(), true);
      } finally { await hold.dispose(); }
    });

    await run('Delayed task response preserves newer task-record selection', async page => {
      const old = (await getState(page)).tasks.find(task => task.status === 'completed'); assert.ok(old);
      const hold = await holdPost(page, '/api/tasks');
      try {
        await page.locator('#prompt-input').fill('合成响应不抢任务记录'); await submit(page).click(); await bounded(hold.seen, 'held task-selection POST');
        await nav(page, 'tasks'); await page.locator('.task-card[data-task="' + old.id + '"]').click();
        assert.equal(await page.locator('.task-card.selected').getAttribute('data-task'), old.id);
        hold.release(); await page.locator('#toast-root .toast').filter({ hasText: '任务已创建' }).waitFor(); await settled(page);
        assert.equal(await page.locator('#main').getAttribute('data-view'), 'tasks');
        assert.equal(await page.locator('.task-card.selected').getAttribute('data-task'), old.id);
      } finally { await hold.dispose(); }
    });

    await run('Modal keyboard new chat, Escape focus and Back Forward preserve drafts', async page => {
      const draft = '合成导航仍保留的草稿'; await page.locator('#prompt-input').fill(draft); await openReminder(page);
      await page.keyboard.press('Control+k'); await settled(page);
      assert.equal(await page.locator('.modal').count(), 0); assert.equal(await page.locator('#prompt-input').inputValue(), draft);
      assert.equal(await page.locator('#prompt-input').evaluate(node => node === document.activeElement), true);
      await page.locator('.composer [data-action="capabilities"]').click(); await page.locator('.capability-list').waitFor();
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('.composer [data-action="capabilities"]').evaluate(node => node === document.activeElement), true);
      await nav(page, 'settings'); await openReminder(page); await page.goBack(); await page.locator('#prompt-input').waitFor(); await ready(page);
      assert.equal(await page.locator('.modal').count(), 0); assert.equal(await page.locator('#prompt-input').inputValue(), draft);
      await page.goForward(); await page.locator('#settings-form').waitFor(); await ready(page);
      assert.equal(await page.locator('.modal').count(), 0); assert.equal(await page.locator('body').evaluate(node => node.style.overflow), '');
    });

    await run('Reminder validation and transport failures keep drafts and explicit retry', async page => {
      const before = (await getState(page)).reminders.length; let posts = 0;
      await page.route('**/api/reminders', route => {
        if (route.request().method() !== 'POST') return route.continue(); posts++;
        if (posts === 1) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'SYNTHETIC_RETAINED_REMINDER_FAILURE' }) });
        return route.continue();
      });
      await openReminder(page); await page.locator('#reminder-title').fill('合成提醒草稿'); await page.locator('#reminder-due').fill('2000-01-01T12:00');
      await page.locator('#reminder-form [type="submit"]').click(); await page.locator('#reminder-form .modal-error').filter({ hasText: '未来' }).waitFor();
      assert.equal(posts, 0); assert.equal(await page.locator('#reminder-title').inputValue(), '合成提醒草稿');
      assert.equal(await page.locator('#reminder-form [type="submit"]').isEnabled(), true);
      await page.locator('#reminder-form [data-action="close-modal"]').click();
      assert.equal(await page.locator('#notification-button').evaluate(node => node === document.activeElement), true);
      await openReminder(page); await page.locator('#reminder-title').fill('合成提醒明确重试');
      await page.locator('#reminder-form [type="submit"]').click(); await page.locator('#reminder-form .modal-error').filter({ hasText: 'SYNTHETIC_RETAINED_REMINDER_FAILURE' }).waitFor();
      assert.equal(await page.locator('#reminder-title').inputValue(), '合成提醒明确重试'); assert.equal((await getState(page)).reminders.length, before);
      await page.locator('#reminder-form [type="submit"]').click(); await page.locator('.modal').waitFor({ state: 'hidden' });
      assert.equal(posts, 2); assert.equal((await getState(page)).reminders.length, before + 1);
    });

    await run('Reminder over Settings and closed late response preserve current edits', async page => {
      await nav(page, 'settings'); await page.locator('#model').fill('SETTINGS_BEHIND_REMINDER'); await openReminder(page);
      await page.locator('#reminder-title').fill('合成设置上方提醒'); await page.locator('#reminder-form [type="submit"]').click();
      await page.locator('.modal').waitFor({ state: 'hidden' }); assert.equal(await page.locator('#model').inputValue(), 'SETTINGS_BEHIND_REMINDER');
      const hold = await holdPost(page, '/api/reminders');
      try {
        await openReminder(page); await page.locator('#reminder-title').fill('合成迟到提醒');
        await page.locator('#reminder-form [type="submit"]').click(); await bounded(hold.seen, 'held reminder success POST'); await page.keyboard.press('Escape');
        await page.locator('#model').fill('NEWER_SETTINGS_AFTER_CLOSE'); hold.release();
        await page.locator('#toast-root .toast').filter({ hasText: '提醒已保存' }).waitFor();
        assert.equal(await page.locator('#model').inputValue(), 'NEWER_SETTINGS_AFTER_CLOSE'); assert.equal(await page.locator('.modal').count(), 0);
      } finally { await hold.dispose(); }
    });

    await run('Late reminder failure leaves a reopened modal draft and error state intact', async page => {
      const hold = await holdPost(page, '/api/reminders', 'http');
      try {
        await openReminder(page); await page.locator('#reminder-title').fill('合成旧提醒请求');
        await page.locator('#reminder-form [type="submit"]').click(); await bounded(hold.seen, 'held reminder failure POST'); await page.keyboard.press('Escape');
        await openReminder(page); await page.locator('#reminder-title').fill('当前新提醒草稿'); hold.release(); await pause(220);
        assert.equal(await page.locator('#reminder-title').inputValue(), '当前新提醒草稿');
        assert.equal(await page.locator('#reminder-form .modal-error').textContent(), '');
        assert.equal(await page.locator('#reminder-form [type="submit"]').isEnabled(), true);
      } finally { await hold.dispose(); }
    });

    await run('Schedules validate timezone and weekdays, retain polling drafts, edit pause resume cancel', async page => {
      await nav(page, 'schedules'); const before = (await getState(page)).schedules.length;
      assert.match(await page.locator('#main').innerText(), /错过的多次执行合并为最多一次/);
      await page.locator('[data-action="add-schedule"]').first().click(); assert.equal(await page.locator('#schedule-timezone').inputValue(), 'Asia/Shanghai');
      await page.locator('#schedule-title').fill('合成每周计划'); await page.locator('#schedule-prompt').fill('整理通用合成资料');
      await page.locator('#schedule-timezone').fill('Bad/Timezone'); await page.locator('#schedule-form [type="submit"]').click();
      await page.locator('#schedule-form .modal-error').filter({ hasText: 'IANA' }).waitFor(); assert.equal((await getState(page)).schedules.length, before);
      assert.equal(await page.locator('#schedule-title').inputValue(), '合成每周计划');
      await page.locator('#schedule-timezone').fill('Asia/Shanghai'); await page.locator('#schedule-recurrence').selectOption('weekly');
      await page.locator('#schedule-days-field input:checked').uncheck(); await page.locator('#schedule-form [type="submit"]').click();
      await page.locator('#schedule-form .modal-error').filter({ hasText: '至少选择一天' }).waitFor();
      await page.locator('#schedule-days-field input[value="1"]').check(); await page.locator('#schedule-days-field input[value="5"]').check();
      await page.locator('#schedule-time').fill('09:30'); await screenshot(page, 'retained-schedule-weekly');
      await page.locator('#schedule-form [type="submit"]').click(); await page.locator('#schedule-form').waitFor({ state: 'hidden' });
      let schedule = (await getState(page)).schedules.find(item => item.title === '合成每周计划'); assert.ok(schedule);
      assert.equal(schedule.timezone, 'Asia/Shanghai'); assert.deepEqual(schedule.recurrence, { type: 'weekly', time: '09:30', daysOfWeek: [1, 5] });
      assert.equal(schedule.agentId, 'coordinator'); const card = () => page.locator('[data-schedule-id="' + schedule.id + '"]');
      assert.match(await card().innerText(), /每周一、五 09:30/); await card().locator('[data-action="edit-schedule"]').click();
      await page.locator('#schedule-title').fill('轮询期间保持的计划草稿');
      app.store.audit('retained.synthetic.poll', '合成后台变化，不覆盖编辑器'); await waitPolls(page);
      assert.equal(await page.locator('#schedule-title').inputValue(), '轮询期间保持的计划草稿'); await page.keyboard.press('Escape');
      assert.equal((await getState(page)).schedules.find(item => item.id === schedule.id).title, '合成每周计划');
      assert.equal(await card().locator('[data-action="edit-schedule"]').evaluate(node => node === document.activeElement), true);
      await card().locator('[data-action="edit-schedule"]').click(); await page.locator('#schedule-title').fill('合成间隔计划');
      await page.locator('#schedule-recurrence').selectOption('interval'); assert.equal(await page.locator('#schedule-time').isDisabled(), true);
      await page.locator('#schedule-interval').fill('525600'); await page.locator('#schedule-agent').selectOption('researcher');
      await page.locator('#schedule-form [type="submit"]').click(); await page.locator('#schedule-form').waitFor({ state: 'hidden' });
      schedule = (await getState(page)).schedules.find(item => item.id === schedule.id);
      assert.deepEqual(schedule.recurrence, { type: 'interval', intervalMinutes: 525600 }); assert.equal(schedule.agentId, 'researcher');
      await card().locator('[data-action="edit-schedule"]').click(); await page.locator('#schedule-agent').selectOption('');
      await page.locator('#schedule-form [type="submit"]').click(); await page.locator('#schedule-form').waitFor({ state: 'hidden' });
      assert.equal((await getState(page)).schedules.find(item => item.id === schedule.id).agentId, 'coordinator');
      await card().locator('[data-action="schedule-pause"]').click(); await card().locator('[data-action="schedule-resume"]').waitFor();
      assert.equal((await getState(page)).schedules.find(item => item.id === schedule.id).status, 'paused');
      await card().locator('[data-action="schedule-resume"]').click(); await card().locator('[data-action="schedule-pause"]').waitFor();
      assert.equal((await getState(page)).schedules.find(item => item.id === schedule.id).status, 'active');
      await card().locator('[data-action="cancel-schedule"]').click(); await page.locator('#modal-root [data-action="close-modal"]').last().click();
      assert.equal((await getState(page)).schedules.find(item => item.id === schedule.id).status, 'active');
      await card().locator('[data-action="cancel-schedule"]').click(); await page.locator('[data-action="schedule-cancel"]').click();
      await page.locator('.modal').waitFor({ state: 'hidden' }); assert.equal((await getState(page)).schedules.find(item => item.id === schedule.id).status, 'cancelled');
      await page.waitForFunction(id => !document.querySelector('[data-schedule-id="' + id + '"] [data-action="edit-schedule"]'), schedule.id);
      assert.equal(await card().locator('[data-action="edit-schedule"]').count(), 0);
      await page.locator('[data-action="add-schedule"]').first().click(); await page.locator('#schedule-title').fill('合成每日计划');
      await page.locator('#schedule-prompt').fill('每日通用合成整理'); await page.locator('#schedule-timezone').fill('America/New_York'); await page.locator('#schedule-time').fill('13:45');
      await page.locator('#schedule-form [type="submit"]').click(); await page.locator('#schedule-form').waitFor({ state: 'hidden' });
      const daily = (await getState(page)).schedules.find(item => item.title === '合成每日计划');
      assert.equal(daily.timezone, 'America/New_York'); assert.deepEqual(daily.recurrence, { type: 'daily', time: '13:45' });
      await screenshot(page, 'retained-schedules');
    });

    await run('Real original DOCX XLSX downloads and links survive reload without task replay', async page => {
      const task = await sendTask(page, '请生成通用合成资料 ' + ARTIFACT_MARKER); await page.locator('.file-download').waitFor();
      const calls = providerCalls.length, tasks = (await getState(page)).tasks.length;
      const originalEvent = page.waitForEvent('download'); await page.locator('.file-download').click();
      const original = await originalEvent, originalPath = join(owned, 'download-original.txt'); await original.saveAs(originalPath);
      assert.equal(await readFile(originalPath, 'utf8'), ARTIFACT_TEXT);
      for (const format of ['docx', 'xlsx']) {
        const event = page.waitForEvent('download'); await page.locator('[data-action="export-task"][data-format="' + format + '"]').click();
        const download = await event, path = join(owned, 'download.' + format); await download.saveAs(path);
        assert.match(download.suggestedFilename(), new RegExp('\\.' + format + '$'));
        const bytes = await readFile(path); assertOffice(bytes, format);
        await page.locator('.office-download').filter({ hasText: format }).waitFor();
        const exported = app.engine.liveTask(task.id).exports.find(item => item.format === format);
        assert.equal(createHash('sha256').update(bytes).digest('hex'), exported.sha256);
      }
      const links = await page.locator('.office-download').evaluateAll(nodes => nodes.map(node => node.getAttribute('href')).sort());
      assert.equal(links.length, 2); await page.reload(); await ready(page); await page.locator('.office-download').first().waitFor();
      assert.deepEqual(await page.locator('.office-download').evaluateAll(nodes => nodes.map(node => node.getAttribute('href')).sort()), links);
      assert.equal(await page.locator('.file-download').count(), 1);
      assert.equal((await getState(page)).tasks.find(item => item.id === task.id).exports.length, 2);
      for (const format of ['docx', 'xlsx']) {
        const event = page.waitForEvent('download'); await page.locator('.office-download').filter({ hasText: format }).click();
        const download = await event, path = join(owned, 'reloaded.' + format); await download.saveAs(path); assertOffice(await readFile(path), format);
      }
      assert.equal((await getState(page)).tasks.length, tasks); assert.equal(providerCalls.length, calls);
      await screenshot(page, 'retained-office-after-reload');
    });

    await run('Fake desktop preference saves preserve Settings drafts; credentials require fresh opt-in', async page => {
      await nav(page, 'settings'); await page.locator('#desktop-settings').waitFor();
      const saveBefore = saves, forgetBefore = forgets;
      await page.locator('#model').fill('UNSAVED_SETTINGS_DURING_DESKTOP_PREFS'); await page.locator('#desktop-background').check();
      await page.locator('#desktop-preferences-form [type="submit"]').click();
      await until(() => desktop.backgroundEnabled, 'fake desktop preference');
      await page.locator('#toast-root .toast').filter({ hasText: '桌面运行偏好已保存' }).waitFor();
      assert.equal(await page.locator('#model').inputValue(), 'UNSAVED_SETTINGS_DURING_DESKTOP_PREFS');
      assert.equal(await page.locator('#desktop-credential-consent').isChecked(), false);
      assert.equal(await page.locator('#desktop-save-credentials').isDisabled(), true); assert.equal(saves, saveBefore);
      await page.locator('#desktop-credential-consent').check(); assert.equal(await page.locator('#desktop-save-credentials').isEnabled(), true);
      await page.locator('#desktop-save-credentials').click(); await page.locator('[data-action="forget-credentials"]').waitFor();
      assert.equal(saves, saveBefore + 1); assert.equal(snapshot.entries.find(item => item.kind === 'global').secret, FAKE_KEY);
      assert.equal(await page.locator('#desktop-credential-consent').isChecked(), false); assert.equal(await page.locator('#desktop-save-credentials').isDisabled(), true);
      assert.ok(!JSON.stringify(await getState(page)).includes(FAKE_KEY)); assert.ok(!JSON.stringify(await browserStorage(page)).includes(FAKE_KEY));
      await noSyntheticKeyInFiles(join(owned, 'app-data'));
      await page.locator('[data-action="forget-credentials"]').click(); await page.keyboard.press('Escape'); assert.equal(forgets, forgetBefore);
      await page.locator('[data-action="forget-credentials"]').click(); await page.locator('[data-action="confirm-forget-credentials"]').click();
      await page.locator('.modal').waitFor({ state: 'hidden' }); await until(() => forgets === forgetBefore + 1, 'forget fake snapshot');
      assert.equal(snapshot, null); assert.equal((await getState(page)).settings.hasApiKey, true);
      await screenshot(page, 'retained-fake-desktop-settings');
    });

    await run('Unavailable fake secure storage and tray disable controls without plaintext fallback', async page => {
      vault.available = false; vault.reason = 'TEST ONLY fake secure backend unavailable'; vault.restoreError = true; desktop.trayAvailable = false;
      try {
        await nav(page, 'settings'); await page.reload(); await ready(page); await page.locator('#desktop-settings').waitFor();
        assert.equal(await page.locator('#desktop-background').isDisabled(), true);
        assert.equal(await page.locator('#desktop-credential-consent').isDisabled(), true);
        assert.equal(await page.locator('#desktop-save-credentials').isDisabled(), true);
        assert.match(await page.locator('#desktop-settings').innerText(), /不会退回明文存储/);
        assert.match(await page.locator('#desktop-settings').innerText(), /已保存的凭据未能恢复/);
        assert.ok(!JSON.stringify(await browserStorage(page)).includes(FAKE_KEY)); await noSyntheticKeyInFiles(join(owned, 'app-data'));
        await screenshot(page, 'retained-fake-vault-unavailable');
      } finally { vault.available = true; vault.reason = ''; delete vault.restoreError; desktop.trayAvailable = true; }
    });

    for (const sample of [
      { width: 1180, height: 812, scale: 1 }, { width: 1280, height: 720, scale: 1 },
      { width: 1440, height: 1000, scale: 1 }, { width: 1920, height: 1080, scale: 2 },
    ]) await run('Actual desktop layout ' + sample.width + 'x' + sample.height + ' at ' + sample.scale + 'x', async page => {
      await page.locator('#prompt-input').fill('合成桌面尺寸草稿');
      assert.equal(await page.locator('#sidebar').isVisible(), true);
      const facts = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, scale: devicePixelRatio, scrollWidth: document.documentElement.scrollWidth, styles: [...document.styleSheets].map(sheet => sheet.href).filter(Boolean) }));
      assert.equal(facts.width, sample.width); assert.equal(facts.height, sample.height); assert.equal(facts.scale, sample.scale);
      assert.ok(facts.scrollWidth <= facts.width, 'No horizontal page overflow');
      assert.ok(facts.styles.some(href => href.endsWith('/chat.css')));
      const composer = await page.locator('.composer').boundingBox(); assert.ok(composer);
      assert.ok(composer.x >= 0 && composer.y >= 0 && composer.x + composer.width <= sample.width + 1 && composer.y + composer.height <= sample.height + 1, 'Composer stays in real viewport');
      report.domFacts.push({ name: 'layout-' + sample.width, facts, composer });
      await screenshot(page, 'retained-chat-' + sample.width + 'x' + sample.height + '-' + sample.scale + 'x');
      await page.locator('.composer [data-action="capabilities"]').click(); await page.locator('.capability-list .capability-row').first().waitFor();
      const modal = await page.locator('.modal').boundingBox(); assert.ok(modal);
      assert.ok(modal.x >= 0 && modal.y >= 0 && modal.x + modal.width <= sample.width + 1 && modal.y + modal.height <= sample.height + 1, 'Tools modal fits real viewport');
      await screenshot(page, 'retained-tools-' + sample.width + '-' + sample.scale + 'x'); await page.keyboard.press('Escape');
      assert.equal(await page.locator('.composer [data-action="capabilities"]').evaluate(node => node === document.activeElement), true);
      await nav(page, 'settings'); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await screenshot(page, 'retained-settings-' + sample.width + '-' + sample.scale + 'x');
    }, { viewport: { width: sample.width, height: sample.height }, deviceScaleFactor: sample.scale });

    if (report.pageErrors.length) report.failures.push({ name: 'No JavaScript page errors', errors: report.pageErrors });
    else report.checks.push({ name: 'No JavaScript page errors' });
    report.status = report.failures.length ? 'failed' : 'passed';
  }
} catch (error) {
  report.status = 'failed'; report.failures.push({ name: options['prepare-only'] ? 'Preparation' : 'Harness', error: error.stack || error.message }); console.error(error.stack || error.message);
} finally {
  await browser?.close(); await standalone?.close(); await app?.close(); await rm(owned, { recursive: true, force: true });
  report.browserStage = options['prepare-only'] ? 'not-run' : report.status === 'passed' ? 'passed' : browser ? 'failed' : 'not-launched';
  report.providerCalls = providerCalls.length;
  await writeFile(join(out, 'retained-chat-settings-results.json'), JSON.stringify(report, null, 2));
  console.log('RESULT ' + report.status + ': ' + report.preparation.length + ' preparation checks; ' + report.checks.length + ' UI checks; ' + report.failures.length + ' failures');
  console.log('Evidence: ' + join(out, 'retained-chat-settings-results.json'));
  if (report.failures.length) process.exitCode = 1;
}
