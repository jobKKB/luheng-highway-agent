'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'luheng-stage-preflight-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const desktop = path.join(root, 'desktop'); fs.mkdirSync(desktop);
  for (const name of ['stage-bundle.cjs', 'stage-utils.cjs']) fs.copyFileSync(path.join(__dirname, '..', name), path.join(desktop, name));
  const bundle = path.join(desktop, process.platform === 'win32' ? 'bundle-win32-x64' : 'bundle');
  fs.mkdirSync(path.join(bundle, 'backend'), { recursive: true });
  const manifest = path.join(bundle, 'bundle-manifest.json');
  fs.writeFileSync(manifest, JSON.stringify({ target: process.platform, arch: process.arch, previousSuccess: true }));
  fs.writeFileSync(path.join(bundle, 'backend', 'sentinel.txt'), 'old source preserved but no longer eligible');
  return { root, desktop, bundle, manifest, run: () => spawnSync(process.execPath, [path.join(desktop, 'stage-bundle.cjs'), process.platform], { encoding: 'utf8', timeout: 5000 }) };
}

test('missing source invalidates a previous staging success before any runtime download', t => {
  const h = fixture(t), result = h.run();
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Missing server\.mjs/);
  assert.equal(fs.existsSync(h.manifest), false);
  assert.equal(fs.readFileSync(path.join(h.bundle, 'backend', 'sentinel.txt'), 'utf8'), 'old source preserved but no longer eligible');
  assert.equal(fs.existsSync(path.join(h.bundle, 'browser-runtime')), false);
});

test('missing production dependency invalidates a previous staging success without downloading', t => {
  const h = fixture(t);
  for (const name of ['server.mjs', 'package.json', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'public/index.html', 'public/app.js']) {
    const file = path.join(h.root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, name === 'package.json' ? '{}' : 'synthetic fixture');
  }
  fs.mkdirSync(path.join(h.root, 'lib'));
  const result = h.run();
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Missing node_modules\/playwright\/package\.json/);
  assert.equal(fs.existsSync(h.manifest), false);
  assert.equal(fs.existsSync(path.join(h.bundle, 'browser-runtime')), false);
});
