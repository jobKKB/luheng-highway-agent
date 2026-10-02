'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync, lstatSync, symlinkSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { DesktopPreferences, TrayLifecycle, shouldHideOnClose } = require('../lifecycle.cjs');

function directory(t) {
  const root = mkdtempSync(join(tmpdir(), 'luheng-preferences-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function trayFixture(overrides = {}) {
  let shown = 0, quit = 0, created = 0;
  class Tray extends EventEmitter {
    constructor(image) { super(); assert.ok(image); created++; this.destroyed = false; }
    isDestroyed() { return this.destroyed; }
    setToolTip(value) { this.tooltip = value; }
    setContextMenu(menu) { this.menu = menu; }
    destroy() { this.destroyed = true; }
  }
  const lifecycle = new TrayLifecycle({
    Tray, Menu: { buildFromTemplate: template => template },
    nativeImage: { createFromPath: () => ({ isEmpty: () => false }) },
    iconPath: 'fixture.png', showWindow: () => shown++, quit: () => quit++, ...overrides,
  });
  return { lifecycle, get shown() { return shown; }, get quit() { return quit; }, get created() { return created; } };
}

test('background mode defaults off, persists only explicit boolean updates', t => {
  const root = directory(t);
  const prefs = new DesktopPreferences(root);
  assert.equal(prefs.backgroundEnabled, false);
  prefs.set({ backgroundEnabled: true });
  assert.equal(new DesktopPreferences(root).backgroundEnabled, true);
  assert.deepEqual(JSON.parse(readFileSync(prefs.file, 'utf8')), { backgroundEnabled: true });
  if (process.platform !== 'win32') assert.equal(lstatSync(prefs.file).mode & 0o777, 0o600);
  prefs.set({ backgroundEnabled: false });
  assert.equal(new DesktopPreferences(root).backgroundEnabled, false);
  assert.deepEqual(readdirSync(root), ['desktop-preferences.json']);
});

test('invalid/malformed background preferences fail closed without overwriting state', t => {
  const root = directory(t);
  const prefs = new DesktopPreferences(root);
  for (const invalid of [null, {}, [], { backgroundEnabled: 'true' }, { backgroundEnabled: true, openAtLogin: true }]) {
    assert.throws(() => prefs.set(invalid));
    assert.equal(prefs.backgroundEnabled, false);
  }
  for (const text of ['not-json', '{"backgroundEnabled":"true"}', '{"backgroundEnabled":true,"extra":1}', ' '.repeat(1025)]) {
    writeFileSync(prefs.file, text);
    assert.equal(new DesktopPreferences(root).backgroundEnabled, false);
  }
});

test('preferences do not read a symbolic-link configuration', { skip: process.platform === 'win32' }, t => {
  const root = directory(t), target = join(root, 'other.json');
  writeFileSync(target, '{"backgroundEnabled":true}');
  symlinkSync(target, join(root, 'desktop-preferences.json'));
  assert.equal(new DesktopPreferences(root).backgroundEnabled, false);
});

test('close hides only with explicit background setting and a live tray', () => {
  const fixture = trayFixture(), lifecycle = fixture.lifecycle;
  let hidden = 0, prevented = 0;
  const window = { hide: () => hidden++ }, event = { preventDefault: () => prevented++ };
  assert.equal(lifecycle.handleClose(event, window, { backgroundEnabled: true }), false);
  assert.equal(lifecycle.create(), true);
  assert.equal(lifecycle.create(), true);
  assert.equal(fixture.created, 1);
  for (const settings of [{}, { backgroundEnabled: false }, { backgroundEnabled: true, exiting: true }])
    assert.equal(lifecycle.handleClose(event, window, settings), false);
  assert.equal(hidden, 0);
  assert.equal(lifecycle.handleClose(event, window, { backgroundEnabled: true, exiting: false }), true);
  assert.equal(hidden, 1); assert.equal(prevented, 1);
  lifecycle.tray.destroy();
  assert.equal(lifecycle.handleClose(event, window, { backgroundEnabled: true }), false);
  assert.equal(hidden, 1);
});

test('tray activation restores window, and its Quit command is a real quit', () => {
  const fixture = trayFixture(); fixture.lifecycle.create();
  const tray = fixture.lifecycle.tray;
  tray.emit('click'); tray.emit('double-click'); tray.menu[0].click();
  assert.equal(fixture.shown, 3);
  tray.menu[2].click(); assert.equal(fixture.quit, 1);
  fixture.lifecycle.destroy(); fixture.lifecycle.destroy();
  assert.equal(tray.destroyed, true); assert.equal(fixture.lifecycle.available(), false);
});

test('missing icon and construction/menu failures disable tray-backed background mode', () => {
  for (const overrides of [
    { nativeImage: { createFromPath: () => ({ isEmpty: () => true }) } },
    { Tray: class { constructor() { throw new Error('fixture'); } } },
    { Menu: { buildFromTemplate() { throw new Error('fixture'); } } },
  ]) {
    const { lifecycle } = trayFixture(overrides);
    assert.equal(lifecycle.create(), false); assert.equal(lifecycle.available(), false);
  }
  assert.equal(shouldHideOnClose({ backgroundEnabled: 'true', trayAvailable: true }), false);
});

test('desktop main has no OS auto-start, preload or renderer IPC bridge', () => {
  const main = readFileSync(join(__dirname, '..', 'main.cjs'), 'utf8');
  assert.doesNotMatch(main, /setLoginItemSettings|openAtLogin|ipcMain\.|contextBridge\.|preload\s*:/);
  assert.match(main, /window\.show\(\)/);
  assert.match(main, /app\.on\('window-all-closed', \(\) => app\.quit\(\)\)/);
});
