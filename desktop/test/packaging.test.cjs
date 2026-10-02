'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { join } = require('node:path');
const { existsSync, readFileSync } = require('node:fs');

test('Windows packaging configuration satisfies electron-builder schema', async () => {
  const { validateConfiguration } = require('app-builder-lib/out/util/config/config.js');
  const config = require('../electron-builder.cjs');
  await validateConfiguration(config, { isEnabled: false, add() {} });
  await validateConfiguration({ ...config, win: { ...config.win, signExecutable: false }, toolsets: { wine: '1.0.1', nsis: '1.2.1' } }, { isEnabled: false, add() {} });
  assert.equal(config.publish, null);
  assert.equal(config.nsis.perMachine, false);
  assert.equal(config.nsis.deleteAppDataOnUninstall, false);
  assert.ok(config.extraResources.some(entry => entry.to === 'browser-runtime'));
  for (const file of ['bridge.cjs', 'vault.cjs', 'lifecycle.cjs']) {
    assert.ok(config.files.includes(file)); assert.ok(existsSync(join(__dirname, '..', file)));
  }
  assert.ok(config.files.includes('assets/**'));
  assert.equal(readFileSync(join(__dirname, '..', 'assets', 'tray.png')).subarray(1, 4).toString(), 'PNG');
});

test('staging rejects unsupported target combinations without any network activity', () => {
  const { stagingPlan } = require('../stage-utils.cjs');
  assert.throws(() => stagingPlan({ target: 'linux', hostPlatform: 'win32', arch: 'x64' }), /cross-staging/);
});
