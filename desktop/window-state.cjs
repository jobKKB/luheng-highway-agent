'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { exactKeys } = require('./vault.cjs');

// Electron window bounds and display work areas use device-independent pixels.
// Keeping both in the same units avoids applying a display's DPI scale twice.
const DEFAULT_SIZE = Object.freeze({ width: 1440, height: 960 });
const MINIMUM_SIZE = Object.freeze({ width: 900, height: 620 });
const validBounds = value => exactKeys(value, ['x', 'y', 'width', 'height'])
  && Object.values(value).every(number => Number.isSafeInteger(number) && Math.abs(number) <= 1000000)
  && value.width > 0 && value.height > 0;
const validState = value => exactKeys(value, ['bounds', 'maximized'])
  && validBounds(value.bounds) && typeof value.maximized === 'boolean';
const clamp = (value, min, max) => Math.max(min, Math.min(value, max));
const overlap = (a, b) => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
  * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));

function resolveWindowState(saved, displays, primaryDisplay) {
  const areas = displays.map(display => display.workArea).filter(validBounds);
  const primary = validBounds(primaryDisplay?.workArea) ? primaryDisplay.workArea : areas[0];
  if (!primary) throw new Error('No usable display work area.');
  const state = validState(saved) ? saved : null;
  let area = primary, bestOverlap = 0;
  if (state) for (const candidate of areas) {
    const intersection = overlap(state.bounds, candidate);
    if (intersection > bestOverlap) { area = candidate; bestOverlap = intersection; }
  }
  const minWidth = Math.min(MINIMUM_SIZE.width, area.width);
  const minHeight = Math.min(MINIMUM_SIZE.height, area.height);
  const width = clamp(state?.bounds.width || DEFAULT_SIZE.width, minWidth, area.width);
  const height = clamp(state?.bounds.height || DEFAULT_SIZE.height, minHeight, area.height);
  // A disconnected monitor or fully off-screen rectangle returns to the primary
  // display. Partial overlap is fitted so the title bar and resize edges remain reachable.
  const x = state && bestOverlap ? clamp(state.bounds.x, area.x, area.x + area.width - width)
    : area.x + Math.floor((area.width - width) / 2);
  const y = state && bestOverlap ? clamp(state.bounds.y, area.y, area.y + area.height - height)
    : area.y + Math.floor((area.height - height) / 2);
  return { bounds: { x, y, width, height }, maximized: state?.maximized === true, minWidth, minHeight };
}

class WindowStateStore {
  constructor(stateRoot) {
    this.file = path.join(stateRoot, 'window-state.json');
    this.state = null;
    try {
      const stat = fs.lstatSync(this.file);
      if (!stat.isFile() || stat.size > 4096) return;
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (validState(saved)) this.state = saved;
    } catch {}
  }
  save(value) {
    if (!validState(value)) return false;
    const state = { bounds: { ...value.bounds }, maximized: value.maximized };
    const temp = path.join(path.dirname(this.file), `.window-${randomBytes(16).toString('hex')}.tmp`);
    try {
      fs.writeFileSync(temp, JSON.stringify(state) + '\n', { flag: 'wx', mode: 0o600 });
      fs.renameSync(temp, this.file);
      this.state = state;
      return true;
    } catch { return false; } // Geometry persistence must never prevent closing.
    finally { try { fs.unlinkSync(temp); } catch {} }
  }
  restore(screen) {
    return resolveWindowState(this.state, screen.getAllDisplays(), screen.getPrimaryDisplay());
  }
}

function manageWindowState(window, screen, store, initialState) {
  let maximized = initialState.maximized;
  let timer;
  const flush = () => {
    clearTimeout(timer);
    if (window.isDestroyed()) return false;
    return store.save({ bounds: window.getNormalBounds(), maximized });
  };
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(flush, 250);
    timer.unref?.();
  };
  const fit = () => {
    if (window.isDestroyed()) return;
    const next = resolveWindowState({ bounds: window.getNormalBounds(), maximized },
      screen.getAllDisplays(), screen.getPrimaryDisplay());
    window.setMinimumSize(next.minWidth, next.minHeight);
    if (!window.isMaximized() && !window.isMinimized() && !window.isFullScreen()) {
      const current = window.getBounds();
      if (Object.keys(next.bounds).some(key => next.bounds[key] !== current[key])) window.setBounds(next.bounds);
    }
    schedule();
  };
  const onMaximize = () => { maximized = true; schedule(); };
  const onUnmaximize = () => {
    // Window managers may report a maximized window as unmaximized while it is
    // minimized or fullscreen. Preserve its normal restore intent in that case.
    if (!window.isMinimized() && !window.isFullScreen()) maximized = false;
    fit();
  };
  const listeners = [
    ['move', schedule], ['resize', schedule], ['maximize', onMaximize],
    ['unmaximize', onUnmaximize], ['restore', fit], ['leave-full-screen', fit],
    ['show', fit], ['close', flush],
  ];
  for (const [event, listener] of listeners) window.on(event, listener);
  const screenEvents = ['display-added', 'display-removed', 'display-metrics-changed'];
  for (const event of screenEvents) screen.on(event, fit);
  const dispose = () => {
    clearTimeout(timer);
    for (const [event, listener] of listeners) window.removeListener(event, listener);
    for (const event of screenEvents) screen.removeListener(event, fit);
  };
  window.once('closed', dispose);
  return { flush, fit };
}

module.exports = { DEFAULT_SIZE, MINIMUM_SIZE, resolveWindowState, WindowStateStore, manageWindowState };
