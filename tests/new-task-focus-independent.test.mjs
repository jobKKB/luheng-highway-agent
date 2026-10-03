import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto, createHash } from 'node:crypto';

// Review-only fixture. It reads the requested application file without modifying it.
// No browser, server, package, user data, or external network is involved.
const sourcePath = process.env.FOCUS_APP_PATH || new URL('../public/app.js', import.meta.url);
const source = await readFile(sourcePath, 'utf8');
const bootstrap = 'renderChrome();loadState();setInterval(()=>loadState(),2000);';
assert.equal(source.split(bootstrap).length, 2, 'exactly one known bootstrap must be removed');
const executable = source.replace(bootstrap, '');
console.log(`Focus review source: ${sourcePath}; SHA256 ${createHash('sha256').update(source).digest('hex')}`);

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture() {
  const events = new Map(), windowEvents = new Map(), focusLog = [], renderLog = [], requests = [], toasts = [];
  const timers = new Map();
  let serial = 0, time = 0, timerSerial = 0;
  const document = { activeElement: null };
  class Element {
    constructor(tagName, id = '', parent = null) {
      this.tagName = tagName.toUpperCase(); this.id = id; this.parent = parent;
      this.serial = ++serial; this.dataset = {}; this.children = []; this.style = {};
      this.isConnected = true; this.disabled = false; this.value = ''; this.selectionStart = 0; this.selectionEnd = 0;
      const classes = new Set();
      this.classList = { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c), toggle: c => classes.has(c) ? classes.delete(c) : classes.add(c) };
    }
    contains(node) { return !!node && (node === this || this.children.includes(node)); }
    focus() {
      if (!this.isConnected || document.activeElement === this) return;
      const previous = document.activeElement;
      document.activeElement = this; focusLog.push({ id: this.id, serial: this.serial, node: this });
      if (previous?.isConnected) for (const callback of events.get('focusout') || []) callback({ target: previous, relatedTarget: this });
      for (const callback of events.get('focusin') || []) callback({ target: this, relatedTarget: previous });
    }
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
    setAttribute() {}
    removeAttribute() {}
    closest(selector) { for (let node = this; node; node = node.parent) if (node.matches(selector)) return node; return null; }
    matches(selector) { return selector === this.tagName.toLowerCase() || selector === '#' + this.id; }
    querySelectorAll(selector) {
      const simple = selector.split(',').map(s => s.trim());
      return this.children.filter(node => simple.some(s => s === node.tagName.toLowerCase() || s === '#' + node.id));
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    set innerHTML(html) {
      if (this.contains(document.activeElement) && document.activeElement !== this) document.activeElement = document.body;
      for (const child of this.children) child.isConnected = false;
      this.children = []; this.html = html;
      // Only form controls and id-bearing elements are needed by this bounded DOM.
      for (const match of html.matchAll(/<(input|textarea|button|form|section|div)\b([^>]*)>/g)) {
        const [, tag, attrs] = match;
        const id = attrs.match(/\bid="([^"]*)"/)?.[1] || '';
        if (!id && !['input', 'textarea', 'button'].includes(tag)) continue;
        const node = new Element(tag, id, this);
        for (const data of attrs.matchAll(/\bdata-([a-z-]+)="([^"]*)"/g)) node.dataset[data[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = data[2];
        node.value = attrs.match(/\bvalue="([^"]*)"/)?.[1] || '';
        if (tag === 'textarea') node.value = html.slice(match.index + match[0].length).split('</textarea>')[0];
        this.children.push(node);
      }
      if (this.id === 'main') renderLog.push({ view: this.dataset.view, prompt: this.children.find(n => n.id === 'prompt-input') });
    }
    get innerHTML() { return this.html || ''; }
    // Stable-DOM slice: a same-view chat refresh parses into a <template> and
    // patches #main's children in place, so the bounded DOM needs node moves.
    get nodeType() { return 1; }
    get nodeName() { return this.tagName; }
    get childNodes() { return this.children; }
    get firstChild() { return this.children[0] || null; }
    get nextSibling() { const siblings = this.parent?.children || []; return siblings[siblings.indexOf(this) + 1] || null; }
    get attributes() { return []; }
    getAttribute(name) { return name === 'id' ? this.id || null : name === 'data-key' ? this.dataset.key ?? null : null; }
    hasAttribute(name) { return this.getAttribute(name) !== null; }
    insertBefore(node, ref) {
      if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1);
      const index = ref ? this.children.indexOf(ref) : -1;
      this.children.splice(index < 0 ? this.children.length : index, 0, node); node.parent = this; node.isConnected = this.isConnected;
      return node;
    }
    removeChild(node) {
      this.children.splice(this.children.indexOf(node), 1); node.isConnected = false;
      if (document.activeElement === node) document.activeElement = document.body;
      return node;
    }
  }
  const body = new Element('body', 'body'), main = new Element('main', 'main'), modalRoot = new Element('div', 'modal-root');
  const launcher = new Element('button', 'new-task-launcher'); launcher.dataset.action = 'new-task';
  body.style.overflow = ''; document.body = body; document.activeElement = body;
  const all = () => [body, main, ...main.children, modalRoot, ...modalRoot.children, launcher];
  Object.assign(document, {
    createElement(tag) { const node = new Element(tag); node.content = node; return node; },
    contains: node => all().includes(node) && node.isConnected,
    addEventListener: (type, callback) => { if (!events.has(type)) events.set(type, []); events.get(type).push(callback); },
    querySelector(selector) {
      if (selector === '#modal-root input, #modal-root button') return modalRoot.children.find(n => ['INPUT', 'BUTTON'].includes(n.tagName)) || null;
      if (/^#[a-z-]+$/.test(selector)) return all().find(n => n.id === selector.slice(1)) || null;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === '[data-action],[data-nav]') return all().filter(n => n.dataset.action || n.dataset.nav);
      if (selector === '[data-action]') return all().filter(n => n.dataset.action);
      return [];
    },
  });
  const storage = new Map();
  const context = vm.createContext({
    document, console, crypto: webcrypto, location: { hash: '#tasks' }, navigator: { platform: 'synthetic' },
    window: { scrollTo() {}, addEventListener(type, callback) { if (!windowEvents.has(type)) windowEvents.set(type, []); windowEvents.get(type).push(callback); } },
    sessionStorage: { getItem: k => storage.get(k), setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) },
    setTimeout(callback, delay = 0) { const id = ++timerSerial; timers.set(id, { callback, due: time + delay }); return id; },
    clearTimeout: id => timers.delete(id),
    setInterval() { throw new Error('Unexpected background timer'); },
    fetch() { throw new Error('Network is forbidden in this fixture'); },
    __request(path) { assert.equal(path, '/api/state'); const held = deferred(); requests.push(held); return held.promise; },
    __toast: (...args) => toasts.push(args),
  });
  vm.runInContext(executable, context, { filename: String(sourcePath), timeout: 1000 });
  // Navigation, render, loadState, modal handling, action, and event listeners
  // remain exactly as shipped, including page templates. Replace unrelated
  // chrome updates, local-access I/O, onboarding, and toast rendering only.
  vm.runInContext(`
    renderChrome = () => {};
    syncLocalAccess = async () => {};
    maybeLocalOnboarding = () => {};
    api = __request;
    toast = __toast;
    loaded = true; online = true; draft = 'synthetic saved draft';
    state.localAccess = { configured: true, mode: 'disabled', roots: [] };
    localAccessLastSignature = JSON.stringify([localAccessAvailable, state.localAccess]);
    render(true);
  `, context, { timeout: 1000 });
  const run = code => vm.runInContext(code, context, { timeout: 1000 });
  const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
  const advance = async ms => {
    time += ms;
    for (let turns = 0; turns < 100; turns++) {
      const next = [...timers.entries()].filter(([, timer]) => timer.due <= time).sort((a, b) => a[1].due - b[1].due)[0];
      if (!next) { await flush(); return; }
      timers.delete(next[0]); next[1].callback(); await flush();
    }
    throw new Error('Fixture timer limit exceeded');
  };
  const respond = async (index, error) => {
    assert.ok(requests[index], `Expected state request ${index}`);
    if (error) requests[index].reject(error);
    else requests[index].resolve({ tasks: [], schedules: [], agents: [], memories: [], reminders: [], audit: [], approvals: [], localAccess: { configured: true, mode: 'disabled', roots: [] } });
    await flush();
    if (!error) assert.equal(toasts.length, 0, 'successful fixture refresh must not hide a caught application error');
  };
  const keyboard = () => {
    const event = { key: 'k', ctrlKey: true, metaKey: false, target: document.activeElement, prevented: false, preventDefault() { this.prevented = true; } };
    for (const callback of events.get('keydown') || []) callback(event);
    assert.equal(event.prevented, true, 'shipped Ctrl+K handler should prevent default');
  };
  return { context, run, document, main, modalRoot, launcher, requests, focusLog, renderLog, toasts, flush, advance, respond, keyboard };
}

test('Ctrl+K closes modal, preserves draft, and focuses the final prompt after slow state refresh', async () => {
  const f = fixture(); f.launcher.focus(); f.run("openModal('reminder')"); await f.advance(30);
  assert.ok(f.modalRoot.contains(f.document.activeElement));
  f.keyboard(); await f.advance(30);
  assert.equal(f.run('modal'), null); assert.equal(f.document.body.style.overflow, '');
  assert.equal(f.run('draft'), 'synthetic saved draft');
  const earlyPrompt = f.document.querySelector('#prompt-input');
  await f.respond(0); await f.advance(30);
  const finalPrompt = f.document.querySelector('#prompt-input');
  assert.equal(finalPrompt, earlyPrompt, 'a same-view forced refresh keeps the mounted prompt node');
  assert.equal(finalPrompt.value, 'synthetic saved draft');
  assert.equal(f.document.activeElement, finalPrompt, 'the current connected prompt must receive focus after refresh');
});

test('new-task focuses prompt when state refresh finishes before the legacy timer', async () => {
  const f = fixture(); const action = f.run("action('new-task')");
  await f.respond(0); await f.advance(30); await action;
  assert.equal(f.document.activeElement, f.document.querySelector('#prompt-input'));
});

test('new-task waits through an already-running poll and its queued forced refresh', async () => {
  const f = fixture(); const poll = f.run('loadState()'); const action = f.run("action('new-task')");
  await f.advance(30); assert.equal(f.requests.length, 1);
  await f.respond(0); await poll; assert.equal(f.requests.length, 2);
  await f.respond(1); await f.advance(30); await action;
  assert.equal(f.document.activeElement, f.document.querySelector('#prompt-input'));
});

test('a newer modal retains focus when the old new-task refresh settles', async () => {
  const f = fixture(); const action = f.run("action('new-task')");
  f.run("openModal('reminder')"); const checkpoint = f.focusLog.length; await f.advance(30);
  const modalFocus = f.document.activeElement; assert.ok(f.modalRoot.contains(modalFocus));
  await f.respond(0); await f.advance(30); await action;
  assert.equal(f.run('modal.kind'), 'reminder'); assert.equal(f.document.body.style.overflow, 'hidden');
  assert.equal(f.document.activeElement, modalFocus);
  assert.equal(f.focusLog.slice(checkpoint).filter(n => n.id === 'prompt-input').length, 0, 'no focus outside the newer modal, including a transient timer callback');
});

test('navigating away while refresh is held never focuses a prompt afterward', async () => {
  const f = fixture(); const action = f.run("action('new-task')");
  const navigation = f.run("navigate('settings')"); const checkpoint = f.focusLog.length;
  await f.advance(30); await f.respond(0); await f.respond(1); await f.advance(30); await action; await navigation;
  assert.equal(f.run('view'), 'settings'); assert.equal(f.document.querySelector('#prompt-input'), null);
  assert.equal(f.focusLog.slice(checkpoint).filter(n => n.id === 'prompt-input').length, 0);
});

test('leaving and returning to chat invalidates the old pending focus request', async () => {
  const f = fixture(); const action = f.run("action('new-task')");
  const away = f.run("navigate('settings')"); const back = f.run("navigate('chat')");
  const checkpoint = f.focusLog.length;
  await f.advance(30); await f.respond(0); await f.respond(1); await f.respond(2); await f.advance(30);
  await action; await away; await back;
  assert.equal(f.run('view'), 'chat');
  assert.equal(f.focusLog.slice(checkpoint).filter(n => n.id === 'prompt-input').length, 0, 'old action must not steal focus merely because view is chat again');
});

test('a failed refresh still leaves the available composer focusable', async () => {
  const f = fixture(); const action = f.run("action('new-task')");
  await f.respond(0, new Error('Synthetic state failure')); await f.advance(30); await action;
  assert.equal(f.document.activeElement, f.document.querySelector('#prompt-input'));
  assert.equal(f.toasts.length, 1);
});

test('repeated new-task actions leave focus on the newest rendered composer', async () => {
  const f = fixture(); const first = f.run("action('new-task')"); const second = f.run("action('new-task')");
  await f.advance(30); await f.respond(0); await f.respond(1); await f.advance(30); await first; await second;
  assert.equal(f.document.activeElement, f.document.querySelector('#prompt-input'));
  assert.equal(f.run('draft'), 'synthetic saved draft');
});

test('an independent forced refresh after new-task completion preserves prompt focus and selection', async () => {
  const f = fixture(); const action = f.run("action('new-task')");
  await f.respond(0); await f.advance(30); await action;
  const before = f.document.querySelector('#prompt-input');
  assert.equal(f.document.activeElement, before, 'the navigation has completed with a focused composer');
  before.setSelectionRange(3, 11);
  const refresh = f.run('loadState(true)');
  await f.respond(1); await refresh; await f.advance(30);
  const after = f.document.querySelector('#prompt-input');
  assert.equal(after, before, 'the independent force refresh keeps the composer node');
  assert.equal(f.document.activeElement, after, 'forced refresh must preserve focus even with unchanged local-access state');
  assert.equal(after.selectionStart, 3); assert.equal(after.selectionEnd, 11);
  assert.equal(after.value, 'synthetic saved draft');
});
