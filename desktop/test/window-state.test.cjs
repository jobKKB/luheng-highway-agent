'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync, lstatSync, symlinkSync, mkdirSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, dirname } = require('node:path');
const { DEFAULT_SIZE, MINIMUM_SIZE, resolveWindowState, WindowStateStore, manageWindowState } = require('../window-state.cjs');

const primary = { workArea: { x: 0, y: 32, width: 1920, height: 1008 } };
const secondary = { workArea: { x: -1600, y: 0, width: 1600, height: 860 } };
const saved = (bounds, maximized = false) => ({ bounds, maximized });
function directory(t) {
  const root = mkdtempSync(join(tmpdir(), 'luheng-window-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function fixture(t, initial = saved({ x: 140, y: 70, width: 1100, height: 700 })) {
  const store = new WindowStateStore(directory(t));
  store.save(initial);
  const screen = Object.assign(new EventEmitter(), {
    displays: [primary, secondary],
    getAllDisplays() { return this.displays; },
    getPrimaryDisplay: () => primary,
  });
  const restored = store.restore(screen);
  const window = Object.assign(new EventEmitter(), {
    bounds: { ...restored.bounds }, normal: { ...restored.bounds },
    maximized: restored.maximized, minimized: false, fullscreen: false, destroyed: false,
    minimum: [restored.minWidth, restored.minHeight], sets: 0,
    isDestroyed() { return this.destroyed; },
    isMaximized() { return this.maximized; },
    isMinimized() { return this.minimized; },
    isFullScreen() { return this.fullscreen; },
    getBounds() { return { ...this.bounds }; },
    getNormalBounds() { return { ...this.normal }; },
    setMinimumSize(width, height) { this.minimum = [width, height]; },
    setBounds(bounds) { this.bounds = { ...bounds }; this.normal = { ...bounds }; this.sets++; this.emit('resize'); },
  });
  const controller = manageWindowState(window, screen, store, restored);
  t.after(() => { window.destroyed = true; window.emit('closed'); });
  return { window, screen, store, controller };
}

test('first launch is centered in the work area with usable native minimums', () => {
  const state = resolveWindowState(null, [primary], primary);
  assert.deepEqual(state.bounds, { x: 240, y: 56, ...DEFAULT_SIZE });
  assert.equal(state.minWidth, MINIMUM_SIZE.width);
  assert.equal(state.minHeight, MINIMUM_SIZE.height);
  assert.equal(state.maximized, false);
});

test('restores normal bounds and maximization on a secondary monitor with negative coordinates', () => {
  const value = saved({ x: -1530, y: 40, width: 1100, height: 700 }, true);
  const state = resolveWindowState(value, [primary, secondary], primary);
  assert.deepEqual(state.bounds, value.bounds);
  assert.equal(state.maximized, true);
});

test('a disconnected monitor returns the window to the center of the primary work area', () => {
  const state = resolveWindowState(saved({ x: -1530, y: 40, width: 1100, height: 700 }, true), [primary], primary);
  assert.deepEqual(state.bounds, { x: 410, y: 186, width: 1100, height: 700 });
  assert.equal(state.maximized, true);
});

test('partial overlap fits all edges and the title bar inside the best matching work area', () => {
  assert.deepEqual(resolveWindowState(saved({ x: 1700, y: -200, width: 1100, height: 800 }), [primary], primary).bounds,
    { x: 820, y: 32, width: 1100, height: 800 });
  assert.equal(resolveWindowState(saved({ x: -1000, y: 20, width: 1200, height: 700 }), [primary, secondary], primary).bounds.x, -1200);
});

test('small and scaled work areas never get a window or minimum larger than their available DIP size', () => {
  const display = { scaleFactor: 2, workArea: { x: 10, y: 48, width: 800, height: 552 } };
  const state = resolveWindowState(saved({ x: 0, y: 0, width: 3000, height: 2000 }), [display], display);
  assert.deepEqual(state.bounds, display.workArea);
  assert.equal(state.minWidth, 800); assert.equal(state.minHeight, 552);
  const normal = resolveWindowState(saved({ x: 20, y: 40, width: 100, height: 100 }), [primary], primary);
  assert.equal(normal.bounds.width, 900); assert.equal(normal.bounds.height, 620);
});

test('invalid geometry is ignored instead of reaching the native window API', () => {
  const fallback = resolveWindowState(null, [primary], primary);
  for (const value of [null, [], {}, { ...saved({ x: 0, y: 0, width: 900, height: 620 }), extra: 1 },
    saved({ x: 0, y: 0, width: 0, height: 620 }), saved({ x: Infinity, y: 0, width: 900, height: 620 }),
    saved({ x: 0.5, y: 0, width: 900, height: 620 }), saved({ x: 0, y: 0, width: 900, height: 620 }, 'true')]) {
    assert.deepEqual(resolveWindowState(value, [primary], primary), fallback);
  }
});

test('state persists atomically and contains only normal geometry and maximize intent', t => {
  const root = directory(t), store = new WindowStateStore(root);
  const value = saved({ x: 500, y: 90, width: 1200, height: 700 }, true);
  assert.equal(store.save(value), true);
  assert.deepEqual(JSON.parse(readFileSync(store.file, 'utf8')), value);
  assert.deepEqual(new WindowStateStore(root).state, value);
  assert.deepEqual(readdirSync(root), ['window-state.json']);
  if (process.platform !== 'win32') assert.equal(lstatSync(store.file).mode & 0o777, 0o600);
  assert.equal(store.save({ ...value, backgroundEnabled: true }), false);
  assert.deepEqual(new WindowStateStore(root).state, value);
});

test('malformed, oversized and non-file state fails safely without rewriting preferences', t => {
  const root = directory(t), store = new WindowStateStore(root);
  for (const contents of ['not json', '{}', ' '.repeat(4097), '{"bounds":{"x":0,"y":0,"width":900,"height":620},"maximized":"true"}']) {
    writeFileSync(store.file, contents);
    assert.equal(new WindowStateStore(root).state, null);
    assert.equal(readFileSync(store.file, 'utf8'), contents);
  }
  rmSync(store.file); mkdirSync(store.file);
  assert.equal(new WindowStateStore(root).state, null);
  assert.equal(store.save(saved({ x: 0, y: 0, width: 900, height: 620 })), false);
  assert.deepEqual(readdirSync(root), ['window-state.json']);
});

test('state does not follow a symbolic-link file', { skip: process.platform === 'win32' }, t => {
  const root = directory(t), target = join(root, 'target.json');
  writeFileSync(target, JSON.stringify(saved({ x: 0, y: 0, width: 900, height: 620 })));
  symlinkSync(target, join(root, 'window-state.json'));
  assert.equal(new WindowStateStore(root).state, null);
});

test('resize is saved after dragging settles, and close immediately flushes the latest bounds', async t => {
  const { window, store } = fixture(t);
  const original = readFileSync(store.file, 'utf8');
  window.normal = { x: 70, y: 70, width: 1250, height: 750 };
  window.emit('resize'); window.emit('move');
  assert.equal(readFileSync(store.file, 'utf8'), original);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.deepEqual(new WindowStateStore(dirname(store.file)).state.bounds, window.normal);
  window.normal.width = 1300; window.emit('resize'); window.emit('close');
  assert.equal(JSON.parse(readFileSync(store.file, 'utf8')).bounds.width, 1300);
});

test('maximizing and minimizing never replace normal bounds or start the next session minimized', t => {
  const { window, store, controller } = fixture(t);
  const normal = { ...window.normal };
  window.maximized = true; window.bounds = primary.workArea; window.emit('maximize');
  window.minimized = true; window.maximized = false; window.emit('unmaximize');
  window.bounds = { x: -32000, y: -32000, width: 0, height: 0 };
  controller.flush();
  assert.deepEqual(store.state, saved(normal, true));
  window.minimized = false; window.maximized = true; window.emit('restore');
  window.maximized = false; window.bounds = normal; window.emit('unmaximize'); controller.flush();
  assert.deepEqual(store.state, saved(normal, false));
});

test('display removal and work area changes recover a visible, hidden or restored normal window', t => {
  const { window, screen, store, controller } = fixture(t, saved({ x: -1500, y: 30, width: 1100, height: 700 }));
  screen.displays = [primary]; screen.emit('display-removed', {}, secondary);
  assert.deepEqual(window.bounds, { x: 410, y: 186, width: 1100, height: 700 });
  window.normal = { x: 4000, y: 4000, width: 1100, height: 700 }; window.bounds = window.normal;
  window.emit('show');
  assert.deepEqual(window.bounds, { x: 410, y: 186, width: 1100, height: 700 });
  controller.flush(); assert.deepEqual(store.state.bounds, window.bounds);
  assert.equal(window.sets, 2);
});

test('fitting respects maximized/fullscreen states and normalizes after their restore', t => {
  const { window, screen, store, controller } = fixture(t);
  window.maximized = true; window.emit('maximize');
  window.normal = { x: 4000, y: 4000, width: 1100, height: 700 };
  screen.emit('display-metrics-changed'); assert.equal(window.sets, 0);
  window.maximized = false; window.fullscreen = true;
  window.emit('unmaximize'); controller.flush(); assert.equal(store.state.maximized, true);
  screen.emit('display-metrics-changed'); assert.equal(window.sets, 0);
  window.fullscreen = false; window.bounds = window.normal; window.emit('leave-full-screen');
  assert.equal(window.sets, 1);
});

test('work area changes lower minimums before fitting a window to a smaller display', t => {
  const { window, screen } = fixture(t);
  const smaller = { workArea: { x: 0, y: 30, width: 800, height: 540 } };
  screen.displays = [smaller]; screen.getPrimaryDisplay = () => smaller;
  screen.emit('display-metrics-changed', {}, smaller, ['workArea', 'scaleFactor']);
  assert.deepEqual(window.minimum, [800, 540]);
  assert.deepEqual(window.bounds, smaller.workArea);
  window.emit('show'); assert.equal(window.sets, 1);
});

test('closed windows release screen listeners and pending saves', t => {
  const { window, screen, controller } = fixture(t);
  window.emit('resize'); window.destroyed = true; window.emit('closed');
  assert.equal(controller.flush(), false);
  for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) assert.equal(screen.listenerCount(event), 0);
  assert.equal(window.listenerCount('resize'), 0);
});

test('desktop main keeps native resize controls and flushes state on quit without renderer privileges', () => {
  const main = readFileSync(join(__dirname, '..', 'main.cjs'), 'utf8');
  assert.match(main, /frame: true, resizable: true, maximizable: true, minimizable: true/);
  assert.match(main, /windowStateController\?\.flush\(\)/);
  assert.match(main, /if \(restored\.maximized\) window\.maximize\(\)/);
  assert.doesNotMatch(main, /preload\s*:|ipcMain\.|contextBridge\./);
});
