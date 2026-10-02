'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const launcher = readFileSync(join(__dirname, '..', 'launch.cmd'), 'utf8');

test('Windows source launcher quotes its executable and avoids a trailing-backslash argv quote', () => {
  const invocation = launcher.split(/\r?\n/).find(line => line.startsWith('"%~dp0node_modules'));
  assert.equal(invocation, '"%~dp0node_modules\\electron\\dist\\electron.exe" "%~dp0." %*');
  // These are string-expansion fixtures, not native Windows execution. Under the
  // documented Windows argv rules, a backslash before the closing quote escapes
  // it; the final dot keeps the intended directory inside a well-formed argument.
  for (const directory of ['C:\\source\\desktop\\', 'C:\\Program Files\\路衡\\desktop\\']) {
    const expanded = invocation.replaceAll('%~dp0', directory);
    assert.ok(expanded.includes(`"${directory}."`));
    assert.ok(!expanded.includes('\\"'));
  }
});

test('Windows source launcher still fails clearly when the Electron runtime is absent', () => {
  assert.match(launcher, /if not exist "%~dp0node_modules\\electron\\dist\\electron\.exe"/);
  assert.match(launcher, /exit \/b 1/);
});
