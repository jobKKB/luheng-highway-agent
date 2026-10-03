import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createHash, webcrypto } from 'node:crypto';

// Bounded synthetic DOM + synthetic local server. Runs the whole shipped
// public/app.js (its real bootstrap, 2 s interval, loadState, render, chrome,
// navigation, createTask, approval and IME listeners) against public/index.html.
// Counts are source-bound DOM operations, not a Windows or pixel acceptance.
// STABLE_DOM_APP_PATH=<other app.js> reruns the same contract against a baseline.
const appPath = process.env.STABLE_DOM_APP_PATH || new URL('../public/app.js', import.meta.url);
const source = await readFile(appPath, 'utf8');
const shell = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const css = await readFile(new URL('../public/ocean.css', import.meta.url), 'utf8');
console.log(`stable-dom source ${appPath}; sha256 ${createHash('sha256').update(source).digest('hex')}`);
const POLLS = 30; // logical 60 s at the shipped 2000 ms poll interval

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const RAW = new Set(['textarea', 'script', 'style', 'title']);
const decode = s => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_, e) => e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' })[e.toLowerCase()]);
const escText = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = s => escText(s).replace(/"/g, '&quot;');
const kebab = k => k.replace(/[A-Z]/g, c => '-' + c.toLowerCase());

class FakeNode {
  constructor(doc) { this.ownerDocument = doc; this.parentNode = null; this.childNodes = []; }
  get parentElement() { return this.parentNode?.nodeType === 1 ? this.parentNode : null; }
  get firstChild() { return this.childNodes[0] || null; }
  get nextSibling() { const s = this.parentNode?.childNodes; return s ? s[s.indexOf(this) + 1] || null : null; }
  get isConnected() { let n = this; while (n.parentNode) n = n.parentNode; return n === this.ownerDocument; }
  get textContent() { return this.nodeType === 3 ? this.data : this.childNodes.map(c => c.nodeType === 8 ? '' : c.textContent).join(''); }
  set textContent(v) { this.replaceChildrenWith([new FakeText(this.ownerDocument, String(v))]); }
  contains(node) { for (let n = node; n; n = n.parentNode) if (n === this) return true; return false; }
  insertBefore(node, ref) {
    if (node.nodeType === 11) { for (const child of [...node.childNodes]) this.insertBefore(child, ref); return node; }
    const doc = this.ownerDocument;
    if (node.parentNode) node.parentNode.removeChild(node, true);
    const index = ref ? this.childNodes.indexOf(ref) : -1;
    this.childNodes.splice(index < 0 ? this.childNodes.length : index, 0, node); node.parentNode = this;
    if (this.isConnected) { doc.record('insert', this, node); doc.inserted(node); }
    return node;
  }
  appendChild(node) { return this.insertBefore(node, null); }
  append(...nodes) { for (const n of nodes) this.appendChild(typeof n === 'string' ? new FakeText(this.ownerDocument, n) : n); }
  removeChild(node, moving = false) {
    const doc = this.ownerDocument, connected = this.isConnected;
    if (connected && !moving) doc.record('remove', this, node);
    if (connected && node.contains(doc.activeElement)) doc.activeElement = doc.body;
    this.childNodes.splice(this.childNodes.indexOf(node), 1); node.parentNode = null;
    return node;
  }
  remove() { this.parentNode?.removeChild(this); }
  replaceWith(node) { const parent = this.parentNode; parent.insertBefore(node, this); parent.removeChild(this); }
  replaceChildrenWith(nodes) {
    const doc = this.ownerDocument;
    if (this.isConnected && this.contains(doc.activeElement) && doc.activeElement !== this) doc.activeElement = doc.body;
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes = [];
    for (const node of nodes) { this.childNodes.push(node); node.parentNode = this; }
    if (this.isConnected) { doc.record('replace-children', this); for (const node of nodes) doc.inserted(node); }
  }
}
class FakeText extends FakeNode {
  constructor(doc, data) { super(doc); this.nodeType = 3; this.nodeName = '#text'; this.data = data; }
  get nodeValue() { return this.data; }
  set nodeValue(v) { this.data = String(v); if (this.isConnected) this.ownerDocument.record('text', this.parentNode, this); }
  insertData(offset, text) { this.nodeValue = this.data.slice(0, offset) + text + this.data.slice(offset); }
  deleteData(offset, count) { this.nodeValue = this.data.slice(0, offset) + this.data.slice(offset + count); }
}
class FakeComment extends FakeNode {
  constructor(doc, data) { super(doc); this.nodeType = 8; this.nodeName = '#comment'; this.data = data; }
  get nodeValue() { return this.data; }
  set nodeValue(v) { this.data = String(v); }
}
class FakeFragment extends FakeNode {
  constructor(doc) { super(doc); this.nodeType = 11; this.nodeName = '#document-fragment'; }
  querySelector(s) { return this.querySelectorAll(s)[0] || null; }
  querySelectorAll(s) { return select(this, s); }
}
class FakeElement extends FakeNode {
  constructor(doc, tag) {
    super(doc); this.nodeType = 1; this.tagName = tag.toUpperCase(); this.nodeName = this.tagName; this.attrs = new Map();
    this.style = {}; this.scrollTop = 0; this._value = null; this.selectionStart = 0; this.selectionEnd = 0;
    this.valueWrites = 0; this.selectionCalls = 0; this.focusCalls = 0;
    const el = this;
    this.dataset = new Proxy({}, {
      get: (_, k) => typeof k === 'string' ? el.getAttribute('data-' + kebab(k)) ?? undefined : undefined,
      set: (_, k, v) => { el.setAttribute('data-' + kebab(k), v); return true; },
      deleteProperty: (_, k) => { el.removeAttribute('data-' + kebab(k)); return true; },
      has: (_, k) => el.hasAttribute('data-' + kebab(k)),
    });
  }
  get localName() { return this.tagName.toLowerCase(); }
  get attributes() { return [...this.attrs].map(([name, value]) => ({ name, value })); }
  getAttribute(n) { n = n.toLowerCase(); return this.attrs.has(n) ? this.attrs.get(n) : null; }
  hasAttribute(n) { return this.attrs.has(n.toLowerCase()); }
  setAttribute(n, v) { n = n.toLowerCase(); v = String(v); if (this.attrs.get(n) === v) return; this.attrs.set(n, v); if (this.isConnected) this.ownerDocument.record('attr', this, n); }
  removeAttribute(n) { n = n.toLowerCase(); if (!this.attrs.has(n)) return; this.attrs.delete(n); if (this.isConnected) this.ownerDocument.record('attr', this, n); }
  toggleBoolean(n, on) { if (on) this.setAttribute(n, ''); else this.removeAttribute(n); }
  get id() { return this.getAttribute('id') || ''; } set id(v) { this.setAttribute('id', v); }
  get className() { return this.getAttribute('class') || ''; } set className(v) { this.setAttribute('class', v); }
  get classList() {
    const el = this, list = () => el.className.split(/\s+/).filter(Boolean);
    return { contains: c => list().includes(c), add: (...c) => { el.className = [...new Set([...list(), ...c])].join(' '); }, remove: (...c) => { if (c.some(x => list().includes(x))) el.className = list().filter(x => !c.includes(x)).join(' '); }, toggle: (c, force) => { const on = force ?? !list().includes(c); if (on) el.classList.add(c); else el.classList.remove(c); return on; } };
  }
  get hidden() { return this.hasAttribute('hidden'); } set hidden(v) { this.toggleBoolean('hidden', !!v); }
  get disabled() { return this.hasAttribute('disabled'); } set disabled(v) { this.toggleBoolean('disabled', !!v); }
  get open() { return this.hasAttribute('open'); } set open(v) { this.toggleBoolean('open', !!v); }
  get checked() { return this.hasAttribute('checked'); } set checked(v) { this.toggleBoolean('checked', !!v); }
  get required() { return this.hasAttribute('required'); } set required(v) { this.toggleBoolean('required', !!v); }
  get name() { return this.getAttribute('name') || ''; }
  get type() { return this.getAttribute('type') || (this.tagName === 'BUTTON' ? 'submit' : 'text'); }
  get value() {
    if (this.tagName === 'TEXTAREA') return this._value ?? this.textContent;
    if (this.tagName === 'SELECT') { const options = select(this, 'option'); const chosen = options.find(o => o.hasAttribute('selected')) || options[0]; return chosen ? chosen.getAttribute('value') ?? chosen.textContent : ''; }
    return this._value ?? this.getAttribute('value') ?? '';
  }
  set value(v) { this._value = String(v); this.valueWrites++; this.selectionStart = this.selectionEnd = this._value.length; if (this.isConnected) this.ownerDocument.record('value', this); }
  setSelectionRange(start, end) { this.selectionCalls++; this.selectionStart = start; this.selectionEnd = end; }
  focus() { this.focusCalls++; this.ownerDocument.focus(this); }
  blur() { if (this.ownerDocument.activeElement === this) this.ownerDocument.focus(this.ownerDocument.body); }
  scrollIntoView() {}
  get children() { return this.childNodes.filter(n => n.nodeType === 1); }
  get innerHTML() { return this.childNodes.map(serialize).join(''); }
  set innerHTML(html) {
    if (this.tagName === 'TEMPLATE') { this.content.childNodes = []; parseInto(this.ownerDocument, String(html), this.content); return; }
    const holder = new FakeFragment(this.ownerDocument); parseInto(this.ownerDocument, String(html), holder);
    if (this.id === 'main') this.ownerDocument.counters.mainInnerHTML++;
    if (this.isConnected) this.ownerDocument.counters.innerHTMLWrites.set(this.id || this.className, (this.ownerDocument.counters.innerHTMLWrites.get(this.id || this.className) || 0) + 1);
    this.replaceChildrenWith([...holder.childNodes]);
  }
  set outerHTML(html) { const holder = new FakeFragment(this.ownerDocument); parseInto(this.ownerDocument, String(html), holder); const parent = this.parentNode; for (const n of [...holder.childNodes]) parent.insertBefore(n, this); parent.removeChild(this); }
  matches(s) { return compile(s).some(parts => matchParts(this, parts, parts.length - 1)); }
  closest(s) { for (let n = this; n?.nodeType === 1; n = n.parentNode) if (n.matches(s)) return n; return null; }
  querySelector(s) { return this.querySelectorAll(s)[0] || null; }
  querySelectorAll(s) { return select(this, s); }
  requestSubmit() { this.ownerDocument.dispatch('submit', { target: this }); }
  get form() { return this.closest('form'); }
  get selectedOptions() { return select(this, 'option').filter(o => o.hasAttribute('selected')); }
}
function serialize(node) {
  if (node.nodeType === 3) return escText(node.data);
  if (node.nodeType === 8) return `<!--${node.data}-->`;
  const attrs = [...node.attrs].map(([k, v]) => ` ${k}="${escAttr(v)}"`).join('');
  return VOID.has(node.localName) ? `<${node.localName}${attrs}>` : `<${node.localName}${attrs}>${node.childNodes.map(serialize).join('')}</${node.localName}>`;
}
function parseInto(doc, html, root) {
  const stack = [root], top = () => stack[stack.length - 1];
  const add = node => { top().childNodes.push(node); node.parentNode = top(); };
  let i = 0;
  while (i < html.length) {
    if (html.startsWith('<!--', i)) { const end = html.indexOf('-->', i + 4); add(new FakeComment(doc, html.slice(i + 4, end < 0 ? html.length : end))); i = end < 0 ? html.length : end + 3; continue; }
    if (html.startsWith('<!', i)) { i = html.indexOf('>', i) + 1; continue; }
    if (html[i] === '<' && html[i + 1] === '/') {
      const end = html.indexOf('>', i), name = html.slice(i + 2, end).trim().toLowerCase();
      for (let d = stack.length - 1; d > 0; d--) if (stack[d].localName === name) { stack.length = d; break; }
      i = end + 1; continue;
    }
    if (html[i] === '<' && /[a-zA-Z]/.test(html[i + 1] || '')) {
      let j = i + 1, quote = null;
      for (; j < html.length; j++) { const c = html[j]; if (quote) { if (c === quote) quote = null; } else if (c === '"' || c === "'") quote = c; else if (c === '>') break; }
      let inner = html.slice(i + 1, j); i = j + 1;
      const selfClose = inner.endsWith('/'); if (selfClose) inner = inner.slice(0, -1);
      const tag = inner.match(/^[a-zA-Z][\w:-]*/)[0], el = doc.createElement(tag);
      for (const a of inner.slice(tag.length).matchAll(/([^\s="'\/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) { const n = a[1].toLowerCase(); if (!el.attrs.has(n)) el.attrs.set(n, decode(a[2] ?? a[3] ?? a[4] ?? '')); }
      add(el);
      if (RAW.has(el.localName)) {
        const close = html.toLowerCase().indexOf('</' + el.localName, i), text = html.slice(i, close < 0 ? html.length : close);
        if (text) { const t = new FakeText(doc, decode(text)); el.childNodes.push(t); t.parentNode = el; }
        i = close < 0 ? html.length : html.indexOf('>', close) + 1; continue;
      }
      if (!selfClose && !VOID.has(el.localName)) stack.push(el);
      continue;
    }
    const next = html.indexOf('<', i + 1), end = next < 0 ? html.length : next;
    add(new FakeText(doc, decode(html.slice(i, end)))); i = end;
  }
}
const compiled = new Map();
function compile(selector) {
  if (compiled.has(selector)) return compiled.get(selector);
  const result = selector.split(',').map(part => {
    const tokens = part.trim().replace(/\s*>\s*/g, ' > ').split(/\s+(?![^\[]*\])/), parts = []; let comb = ' ';
    for (const token of tokens) { if (token === '>') { comb = '>'; continue; } const c = { tag: null, ids: [], classes: [], attrs: [], checked: false };
      for (const m of token.matchAll(/^([a-zA-Z][\w-]*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:=(?:"([^"]*)"|([^\]]*)))?\]|:(checked)/g)) {
        if (m[1]) c.tag = m[1].toUpperCase(); else if (m[2]) c.ids.push(m[2]); else if (m[3]) c.classes.push(m[3]); else if (m[4]) c.attrs.push([m[4], m[5] ?? m[6]]); else if (m[7]) c.checked = true;
      }
      parts.push({ comb, c }); comb = ' '; }
    return parts;
  });
  compiled.set(selector, result); return result;
}
function matchCompound(el, c) {
  if (el?.nodeType !== 1) return false;
  if (c.tag && el.tagName !== c.tag) return false;
  if (c.ids.some(id => el.id !== id)) return false;
  if (c.classes.length) { const cls = el.className.split(/\s+/); if (c.classes.some(x => !cls.includes(x))) return false; }
  if (c.attrs.some(([n, v]) => v === undefined ? !el.hasAttribute(n) : el.getAttribute(n) !== v)) return false;
  return !c.checked || el.checked;
}
function matchParts(el, parts, idx) {
  if (!matchCompound(el, parts[idx].c)) return false;
  if (idx === 0) return true;
  for (let p = el.parentNode; p?.nodeType === 1; p = p.parentNode) { if (matchParts(p, parts, idx - 1)) return true; if (parts[idx].comb === '>') return false; }
  return false;
}
function select(root, selector) {
  const out = [], parts = compile(selector);
  const walk = node => { for (const child of node.childNodes) { if (child.nodeType === 1) { if (parts.some(p => matchParts(child, p, p.length - 1))) out.push(child); walk(child); } } };
  walk(root); return out;
}
class FakeDocument extends FakeNode {
  constructor() {
    super(null); this.ownerDocument = this; this.nodeType = 9; this.listeners = new Map(); this.log = [];
    this.counters = { mainInnerHTML: 0, homeMainInserted: 0, innerHTMLWrites: new Map() };
    parseInto(this, shell, this);
    this.documentElement = this.childNodes.find(n => n.nodeType === 1); this.body = this.querySelector('body'); this.activeElement = this.body;
  }
  get isConnected() { return true; }
  record(type, target, node) { this.log.push({ type, target, node }); }
  inserted(node) { const visit = n => { if (n.nodeType !== 1) return; if (n.classList.contains('home-main')) this.counters.homeMainInserted++; n.childNodes.forEach(visit); }; visit(node); }
  createElement(tag) { const el = new FakeElement(this, tag); if (el.tagName === 'TEMPLATE') el.content = new FakeFragment(this); return el; }
  getElementById(id) { return this.querySelector('#' + id); }
  querySelector(s) { return this.querySelectorAll(s)[0] || null; }
  querySelectorAll(s) { return select(this, s); }
  contains(node) { return !!node?.isConnected; }
  addEventListener(type, callback) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(callback); }
  removeEventListener() {}
  dispatch(type, init) { const event = { type, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...init }; for (const cb of this.listeners.get(type) || []) cb(event); return event; }
  focus(el) { if (!el?.isConnected || this.activeElement === el) return; const previous = this.activeElement; this.activeElement = el; if (previous && previous !== this.body) this.dispatch('focusout', { target: previous, relatedTarget: el }); this.dispatch('focusin', { target: el, relatedTarget: previous }); }
}

function makeServer() {
  const s = { tick: 0, requests: [], tasks: [], details: new Map(), approvals: [], local: { mode: 'confirm', revision: 1, pending: [], operations: [] }, created: 0 };
  const clone = v => JSON.parse(JSON.stringify(v));
  s.count = (prefix) => s.requests.filter(r => r.startsWith(prefix)).length;
  s.state = () => ({
    settings: { mode: 'api', model: 'synthetic-test-model', hasApiKey: true, budget: 20, heartbeat: true },
    system: { name: '路衡办公智能体', version: '0.5.1', heartbeat: true, lastHeartbeat: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, 500 * ++s.tick)).toISOString() },
    tasks: clone(s.tasks), schedules: [], agents: [{ id: 'coordinator', name: '办公助手', enabled: true, permissions: ['knowledge.read'] }], memories: [], reminders: [], audit: [], approvals: clone(s.approvals),
    notifications: [], mail: [], mailAccounts: [], mailOutbox: [], mailApprovals: [], realInbox: [], browserTargets: [], controlledSessions: [], browserApprovals: [], desktop: { available: false },
    localAccess: { summariesOnly: true, mode: s.local.mode },
  });
  s.localState = () => ({ localAccess: { mode: s.local.mode, configured: true, roots: ['/synthetic/root'], allFiles: false, platform: 'win32', revision: s.local.revision, pending: clone(s.local.pending), operations: clone(s.local.operations) } });
  s.fetch = async (path, options = {}) => {
    const method = options.method || 'GET'; s.requests.push(method === 'GET' ? path : method + ' ' + path);
    const ok = body => ({ ok: true, status: 200, json: async () => body });
    if (path === '/api/state') return ok(s.state());
    if (path === '/api/local-access/state') return ok(s.localState());
    let m;
    if (method === 'GET' && (m = path.match(/^\/api\/tasks\/([^/]+)$/)) && s.details.has(decodeURIComponent(m[1]))) return ok(clone(s.details.get(decodeURIComponent(m[1]))));
    if (method === 'POST' && path === '/api/tasks') { const body = JSON.parse(options.body); const task = { id: 'created-' + ++s.created, title: body.prompt, prompt: body.prompt, status: 'queued', agentId: 'coordinator', createdAt: '2026-01-01T00:00:00.000Z', steps: [] }; s.tasks.unshift(task); return ok({ task }); }
    if (method === 'POST' && (m = path.match(/^\/api\/approvals\/([^/]+)$/))) { s.onApprove?.(decodeURIComponent(m[1])); return ok({ ok: true }); }
    return { ok: false, status: 404, json: async () => ({ error: 'synthetic route not found' }) };
  };
  return s;
}

const bootstrap = 'renderChrome();loadState();setInterval(()=>loadState(),2000);';
assert.equal(source.split(bootstrap).length, 2, 'the shipped bootstrap is present exactly once and runs unchanged');

async function boot({ server = makeServer(), activeChat = null, hash = '' } = {}) {
  const doc = new FakeDocument(), timers = new Map(), storage = new Map();
  if (activeChat) storage.set('luheng-active-chat', activeChat);
  let now = 0, serial = 0;
  const win = { scrollY: 0, scrollTo(opts) { win.scrollY = typeof opts === 'object' ? opts.top ?? 0 : opts; }, addEventListener() {} };
  class FakeFormData { constructor(form) { this.values = {}; for (const el of form.querySelectorAll('textarea,select,input')) if (el.name) this.values[el.name] = el.value; } get(k) { return this.values[k] ?? null; } }
  const context = vm.createContext({
    document: doc, window: win, location: { hash }, navigator: { platform: 'Win32', clipboard: { writeText: async () => {} } },
    sessionStorage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)), removeItem: k => storage.delete(k) },
    fetch: server.fetch, AbortController, FormData: FakeFormData, URL, console, crypto: webcrypto, CSS: { escape: v => String(v) },
    setTimeout: (cb, ms = 0) => { const id = ++serial; timers.set(id, { cb, due: now + ms }); return id; },
    clearTimeout: id => timers.delete(id),
    setInterval: (cb, ms) => { const id = ++serial; timers.set(id, { cb, due: now + ms, every: ms }); return id; },
    clearInterval: id => timers.delete(id),
  });
  const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(r => setImmediate(r)); };
  const advance = async ms => {
    const target = now + ms;
    for (;;) {
      const [id, timer] = [...timers.entries()].filter(([, t]) => t.due <= target).sort((a, b) => a[1].due - b[1].due)[0] || [];
      if (!timer) break;
      now = timer.due; if (timer.every) timer.due += timer.every; else timers.delete(id);
      timer.cb(); await settle();
    }
    now = target; await settle();
  };
  vm.runInContext(source, context, { filename: String(appPath) });
  await settle();
  const $ = s => doc.querySelector(s), main = $('#main');
  const f = { doc, server, context, win, $, main, settle, advance, run: code => vm.runInContext(code, context) };
  f.poll = async (n = 1, each) => { for (let i = 0; i < n; i++) { await advance(2000); if (each) await each(i); } };
  f.click = el => doc.dispatch('click', { target: el });
  f.type = (el, text) => { el._value = text; el.selectionStart = el.selectionEnd = text.length; doc.dispatch('input', { target: el }); };
  f.mainLog = (since = 0) => doc.log.slice(since).filter(r => main.contains(r.target));
  f.mark = () => doc.log.length;
  f.snapshot = () => ({ mainInnerHTML: doc.counters.mainInnerHTML, homeMainInserted: doc.counters.homeMainInserted, mainOps: f.mainLog().length, nav: doc.counters.innerHTMLWrites.get('nav') || 0, heartbeatCard: doc.counters.innerHTMLWrites.get('heartbeat-card') || 0 });
  f.delta = (before) => { const after = f.snapshot(); return Object.fromEntries(Object.keys(after).map(k => [k, after[k] - before[k]])); };
  return f;
}
// Node identity checks stay cheap on failure (no deep inspection of the DOM graph).
const same = (actual, expected, message = 'expected the same DOM node') => assert.ok(actual === expected, message);
const metric = (name, values) => console.log(`METRIC ${name} ${Object.entries(values).map(([k, v]) => `${k}=${v}`).join(' ')}`);

test('css contract: .home-main entry animation is bound to node insertion, so insertions are what replay it', () => {
  assert.match(css, /\.home-main\{animation:home-enter \.35s ease both\}/);
});

test('idle heartbeat: 30 polls (logical 60 s) change only lastHeartbeat and write nothing to #main, composer or chrome', async () => {
  const f = await boot();
  assert.equal(f.main.dataset.view, 'chat'); assert.ok(f.$('.welcome'));
  assert.equal(f.doc.counters.mainInnerHTML, 1, 'the first load is the single real entry'); assert.equal(f.doc.counters.homeMainInserted, 1);
  const prompt = f.$('#prompt-input'), homeMain = f.$('.home-main'), beats = new Set();
  let before = f.snapshot();
  await f.poll(POLLS, () => beats.add(f.run('state.system.lastHeartbeat')));
  let d = f.delta(before);
  metric('idle-unfocused', { polls: POLLS, heartbeatValues: beats.size, ...d, promptSame: f.$('#prompt-input') === prompt });
  assert.equal(beats.size, POLLS, 'every poll carried a new heartbeat timestamp');
  assert.equal(f.server.count('/api/state'), POLLS + 1, 'polling is not stopped or slowed');
  assert.deepEqual(d, { mainInnerHTML: 0, homeMainInserted: 0, mainOps: 0, nav: 0, heartbeatCard: 0 });
  same(f.$('#prompt-input'), prompt, 'composer textarea node kept'); same(f.$('.home-main'), homeMain, '.home-main node kept');
  prompt.focus(); f.type(prompt, '巡查周报草稿'); prompt.setSelectionRange(2, 5);
  before = f.snapshot();
  await f.poll(POLLS);
  d = f.delta(before);
  metric('idle-focused', { polls: POLLS, ...d, promptSame: f.$('#prompt-input') === prompt, pendingRender: f.run('pendingRender') });
  assert.deepEqual(d, { mainInnerHTML: 0, homeMainInserted: 0, mainOps: 0, nav: 0, heartbeatCard: 0 });
  same(f.doc.activeElement, prompt, 'focus stays on the composer'); assert.equal(prompt.value, '巡查周报草稿'); assert.deepEqual([prompt.selectionStart, prompt.selectionEnd], [2, 5]);
  assert.equal(prompt.valueWrites, 0, 'the app never wrote the textarea value');
});

test('task progress patches only changed task regions; composer node, draft and focus stay; progress stays visible while typing', async () => {
  const server = makeServer();
  const task = { id: 't1', title: '整理养护周报', prompt: '汇总巡查记录并形成周报', status: 'running', agentId: 'coordinator', createdAt: '2026-01-01T00:00:00.000Z', budget: 40, budgetUsed: 0, steps: [] };
  server.tasks = [task];
  const f = await boot({ server, activeChat: 't1' });
  const prompt = f.$('#prompt-input'), form = f.$('#task-form'), article = f.$('[data-key="task:t1"]') || f.$('.task-detail'), homeMain = f.$('.home-main');
  const promptText = f.$('.prompt-block').firstChild, mark = f.mark();
  let before = f.snapshot(), stale = 0;
  const step = i => { task.steps.push({ name: '步骤-' + (i + 1), status: 'completed' }); task.budgetUsed = i + 1; if (i === POLLS - 1) { task.status = 'completed'; task.output = '### 周报\n完成'; } };
  step(0);
  await f.poll(POLLS / 2, async i => { if (!f.$('.execution-disclosure summary span')?.textContent.includes(`${i + 1} 个步骤`)) stale++; step(i + 1); });
  const unfocused = f.delta(before);
  const livePrompt = f.$('#prompt-input'); livePrompt.focus(); f.type(livePrompt, '下一项：起草协调邮件');
  before = f.snapshot();
  await f.poll(POLLS / 2, async i => { const n = POLLS / 2 + i + 1; if (!f.$('.execution-disclosure summary span')?.textContent.includes(`${n} 个步骤`)) stale++; if (n < POLLS) step(n); });
  const focused = f.delta(before);
  await f.poll(1);
  // Generic chat disables sending a follow-up while the current turn runs.
  // Only the existing send button's disabled attribute may change on completion.
  const permittedSendState = r => r.type === 'attr' && r.node === 'disabled' && r.target === form.querySelector('button[type="submit"]');
  const ops = f.mainLog(mark), outsideTask = ops.filter(r => !article.contains(r.target) && !permittedSendState(r)).length;
  const composerOps = ops.filter(r => !permittedSendState(r) && (form.contains(r.target) || f.$('.home-toolbar').contains(r.target) || f.$('.composer-note').contains(r.target))).length;
  metric('task-progress', { polls: POLLS, unfocusedMainInnerHTML: unfocused.mainInnerHTML, focusedMainInnerHTML: focused.mainInnerHTML, homeMainInserted: unfocused.homeMainInserted + focused.homeMainInserted, staleProgressPolls: stale, promptSame: f.$('#prompt-input') === prompt, articleSame: f.$('.task-detail') === article, taskOps: ops.filter(r => article.contains(r.target)).length, composerOps, opsOutsideTaskStatusAreas: outsideTask });
  assert.equal(unfocused.mainInnerHTML + focused.mainInnerHTML, 0); assert.equal(unfocused.homeMainInserted + focused.homeMainInserted, 0);
  assert.equal(stale, 0, 'every progress change was visible on its poll, including while typing');
  same(f.$('#prompt-input'), prompt, 'composer textarea node kept'); same(f.$('#task-form'), form, 'composer form node kept'); same(f.$('.home-main'), homeMain, '.home-main node kept'); same(f.$('.task-detail'), article, 'task message node kept');
  same(f.doc.activeElement, prompt, 'focus stays on the composer'); assert.equal(prompt.value, '下一项：起草协调邮件'); assert.equal(prompt.valueWrites, 0);
  same(f.$('.prompt-block').firstChild, promptText, 'an unchanged region keeps its text node');
  assert.match(f.$('.task-detail .badge').textContent, /已完成/); assert.match(f.$('.task-result').textContent, /完成/);
  assert.equal(composerOps, 0, 'no composer, toolbar or composer-note operation except existing send disabled state');
  assert.equal(form.querySelector('button[type="submit"]').disabled, false, 'completed turn enables the non-empty follow-up draft');
  assert.equal(outsideTask, 0, 'outside the task message only the existing send disabled state changed');
});

test('submitting from the composer clears the draft in the same node and shows the new task message', async () => {
  const f = await boot();
  const prompt = f.$('#prompt-input'), form = f.$('#task-form'), homeMain = f.$('.home-main'), before = f.snapshot();
  prompt.focus(); f.type(prompt, '请5分钟后提醒我检查台账');
  form.requestSubmit(); await f.settle(); await f.advance(10);
  const d = f.delta(before);
  metric('submit', { ...d, promptSame: f.$('#prompt-input') === prompt, value: JSON.stringify(prompt.value), thread: !!f.$('.chat-thread .task-detail') });
  assert.equal(f.server.count('POST /api/tasks'), 1);
  same(f.$('#prompt-input'), prompt, 'composer textarea node kept'); same(f.$('.home-main'), homeMain, '.home-main node kept'); assert.equal(d.mainInnerHTML, 0); assert.equal(d.homeMainInserted, 0);
  assert.equal(prompt.value, '', 'a successful submission clears the unchanged draft'); assert.equal(f.run('draft'), '');
  assert.match(f.$('.chat-thread .task-detail h2').textContent, /请5分钟后提醒我检查台账/);
});

test('permission revision changes patch only the pill/approval area; draft, focus, selection, IME composition, selected text and scroll survive', async () => {
  const server = makeServer();
  server.tasks = [{ id: 't1', title: '养护协调', prompt: '起草协调说明', status: 'completed', agentId: 'coordinator', createdAt: '2026-01-01T00:00:00.000Z', output: '已选中的结果正文', steps: [{ name: '完成', status: 'completed' }] }];
  const f = await boot({ server, activeChat: 't1' });
  const prompt = f.$('#prompt-input'), pill = f.$('#local-access-toggle'), thread = f.$('.chat-thread'), homeMain = f.$('.home-main');
  const selectedText = f.$('.task-result').firstChild; assert.equal(selectedText.data, '已选中的结果正文');
  thread.scrollTop = 40; f.win.scrollY = 300; // the user is reading above the bottom
  prompt.focus(); f.type(prompt, '路衡起草'); prompt.setSelectionRange(1, 3);
  f.doc.dispatch('compositionstart', { target: prompt }); f.type(prompt, '路衡起草gong'); prompt.setSelectionRange(4, 8);
  const selectionCalls = prompt.selectionCalls, focusCalls = prompt.focusCalls, before = f.snapshot(), mark = f.mark();
  const labels = [];
  await f.poll(POLLS, async i => {
    server.local.revision++; server.local.mode = i % 2 ? 'confirm' : 'read_only';
    if (i === 4) server.local.pending = [{ id: 'op-1', kind: 'write', status: 'pending', summary: '写入巡查记录', snapshot: { kind: 'write', path: '/synthetic/root/a.txt', content: 'A' }, digest: 'd1', createdAt: '2026-01-01T00:00:01.000Z' }];
    labels.push(f.$('#local-access-toggle span').textContent);
  });
  await f.poll(1);
  const d = f.delta(before);
  const outside = f.mainLog(mark).filter(r => !(f.$('.local-access-selector').contains(r.target) || f.$('.local-conversation')?.contains(r.target) || (r.target === thread && r.node?.classList?.contains('local-conversation'))));
  metric('permission-ime', { polls: POLLS, ...d, promptSame: f.$('#prompt-input') === prompt, pillSame: f.$('#local-access-toggle') === pill, selectionCallsDuringIME: prompt.selectionCalls - selectionCalls, refocusCalls: prompt.focusCalls - focusCalls, valueWrites: prompt.valueWrites, selectedTextConnected: selectedText.isConnected, threadScroll: f.$('.chat-thread').scrollTop, opsOutsidePermissionAreas: outside.length });
  assert.equal(d.mainInnerHTML, 0); assert.equal(d.homeMainInserted, 0);
  same(f.$('#prompt-input'), prompt, 'composer textarea node kept'); same(f.$('#local-access-toggle'), pill, 'permission pill node kept'); same(f.$('.home-main'), homeMain, '.home-main node kept'); same(f.$('.chat-thread'), thread, 'thread node kept');
  same(f.doc.activeElement, prompt, 'focus stays on the composer'); assert.equal(prompt.value, '路衡起草gong'); assert.deepEqual([prompt.selectionStart, prompt.selectionEnd], [4, 8]);
  assert.equal(prompt.valueWrites, 0, 'no programmatic value write while composing');
  assert.equal(prompt.selectionCalls - selectionCalls, 0, 'no selection reset during the open IME composition'); assert.equal(prompt.focusCalls - focusCalls, 0);
  assert.equal(selectedText.isConnected, true, 'the selected result text node is never replaced'); assert.equal(thread.scrollTop, 40); assert.equal(f.win.scrollY, 300);
  assert.deepEqual(labels.slice(-2), ['请求批准', '只读访问'], 'each poll shows the latest permission revision'); assert.equal(f.$('#local-access-toggle span').textContent, '请求批准');
  assert.match(f.$('.local-approval-card').textContent, /批准这一次/);
  assert.equal(outside.length, 0, 'every DOM operation stayed inside the pill/popover or local approval area');
  f.doc.dispatch('compositionend', { target: prompt });
});

test('navigation is an intentional update: each real entry mounts once, later polls do not', async () => {
  const f = await boot();
  const first = f.$('#prompt-input');
  f.click(f.$('[data-nav="tasks"]')); await f.settle();
  assert.equal(f.run('view'), 'tasks'); same(f.$('#prompt-input'), null, 'no composer outside chat');
  const before = f.snapshot();
  f.click(f.$('[data-nav="chat"]')); await f.settle();
  const entry = f.delta(before), second = f.$('#prompt-input');
  const afterEntry = f.snapshot();
  await f.poll(POLLS);
  const later = f.delta(afterEntry);
  metric('navigation', { entryMainInnerHTML: entry.mainInnerHTML, entryHomeMainInserted: entry.homeMainInserted, laterMainInnerHTML: later.mainInnerHTML, laterHomeMainInserted: later.homeMainInserted, remounted: second !== first });
  assert.equal(entry.mainInnerHTML, 1, 'returning to chat mounts once; its forced state refresh patches'); assert.equal(entry.homeMainInserted, 1, 'returning to chat plays the entry once');
  assert.ok(second !== first, 'a real entry mounts a fresh composer'); assert.equal(f.run('view'), 'chat');
  assert.deepEqual([later.mainInnerHTML, later.homeMainInserted], [0, 0]); same(f.$('#prompt-input'), second, 'polls after the entry keep the composer');
});

test('settled local task detail: unchanged completed detail is fetched once; change, switch and approval refresh promptly', async () => {
  const server = makeServer();
  const summary = (id, status, extra = {}) => ({ id, title: '本机任务 ' + id, prompt: '仅本次运行可见', status, agentId: 'coordinator', createdAt: '2026-01-01T00:00:00.000Z', localContext: true, liveResultAvailable: true, updatedAt: '2026-01-01T00:00:00.000Z', ...extra });
  server.tasks = [summary('t1', 'completed'), summary('t2', 'completed'), summary('t3', 'waiting_approval')];
  server.details.set('t1', { ...summary('t1', 'completed'), output: 'PRIVATE-RESULT-A' });
  server.details.set('t2', { ...summary('t2', 'completed'), output: 'PRIVATE-RESULT-B' });
  server.details.set('t3', { ...summary('t3', 'waiting_approval'), output: '' });
  server.approvals = [{ id: 'a3', taskId: 't3', status: 'pending', type: 'workspace.write', summary: '生成文件需要确认' }];
  server.onApprove = id => { assert.equal(id, 'a3'); server.approvals = []; server.tasks[2] = summary('t3', 'completed', { updatedAt: '2026-01-01T00:01:00.000Z' }); server.details.set('t3', { ...server.tasks[2], output: 'PRIVATE-RESULT-C' }); };
  const f = await boot({ server, activeChat: 't1' });
  assert.match(f.$('.chat-thread').textContent, /PRIVATE-RESULT-A/);
  await f.poll(POLLS);
  const idle = { state: server.count('/api/state'), local: server.count('/api/local-access/state'), detail: server.count('/api/tasks/t1') };
  metric('detail-idle', { polls: POLLS, ...idle, mainInnerHTML: f.doc.counters.mainInnerHTML });
  assert.deepEqual(idle, { state: POLLS + 1, local: POLLS + 1, detail: 1 }, 'state/local polling continues; the unchanged settled detail is not refetched');
  server.tasks[0] = summary('t1', 'completed', { updatedAt: '2026-01-01T00:02:00.000Z' }); server.details.set('t1', { ...server.tasks[0], output: 'PRIVATE-RESULT-A2' });
  await f.poll(1);
  assert.equal(server.count('/api/tasks/t1'), 2, 'a changed summary refetches on the next poll'); assert.match(f.$('.chat-thread').textContent, /PRIVATE-RESULT-A2/);
  f.click(f.$('[data-nav="tasks"]')); await f.settle();
  f.click(f.$('[data-task="t2"]')); await f.settle();
  assert.equal(server.count('/api/tasks/t2'), 1, 'switching tasks fetches immediately'); assert.match(f.main.textContent, /PRIVATE-RESULT-B/);
  await f.poll(5); assert.equal(server.count('/api/tasks/t2'), 1);
  f.click(f.$('[data-task="t3"]')); await f.settle();
  const activeBefore = server.count('/api/tasks/t3');
  await f.poll(2); assert.equal(server.count('/api/tasks/t3') - activeBefore, 2, 'a task awaiting approval keeps refreshing every poll');
  f.click(f.$('[data-action="approve"][data-id="a3"]')); await f.settle(); await f.advance(10);
  assert.equal(server.count('POST /api/approvals/a3'), 1); assert.match(f.main.textContent, /PRIVATE-RESULT-C/, 'approval result is shown right after the forced refresh');
  const settled = server.count('/api/tasks/t3'); await f.poll(5); assert.equal(server.count('/api/tasks/t3'), settled);
  f.click(f.$('[data-nav="settings"]')); await f.settle(); await f.poll(1);
  f.click(f.$('[data-nav="tasks"]')); await f.settle();
  assert.equal(server.count('/api/tasks/t3'), settled + 1, 'leaving the task drops the cached private detail; returning fetches once');
  metric('detail-refresh', { t1: server.count('/api/tasks/t1'), t2: server.count('/api/tasks/t2'), t3: server.count('/api/tasks/t3') });
});
