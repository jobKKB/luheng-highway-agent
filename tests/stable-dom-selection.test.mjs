import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createHash, webcrypto } from 'node:crypto';

// Selection lifecycle of task answer text under the whole shipped public/app.js (real
// bootstrap, 2 s interval, loadState -> render -> morph) on a DOM fixture whose live
// Ranges follow the WHATWG DOM algorithms instead of only tracking node identity:
//   "insert" / "remove" a node (DOM §4.2.3) and CharacterData "replace data" (§4.10)
//   update every live Range; boundary-point order, contained nodes, toString(),
//   intersectsNode() and comparePoint() follow §5.2/§5.5; getSelection().getRangeAt(0)
//   returns the selection's own live Range and selectionchange is queued whenever the
//   selection or its boundary points change (Selection API).
// Counts are source-bound DOM operations, not a Windows or pixel acceptance.
// STABLE_SELECTION_APP_PATH=<other app.js> reruns the same contract against another build.
const appPath = process.env.STABLE_SELECTION_APP_PATH || new URL('../public/app.js', import.meta.url);
const source = await readFile(appPath, 'utf8');
const shell = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
console.log(`stable-selection source ${appPath}; sha256 ${createHash('sha256').update(source).digest('hex')}`);

// ---------------------------------------------------------------- spec-modelled DOM
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const RAW = new Set(['textarea', 'script', 'style', 'title']);
const decode = s => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_, e) => e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' })[e.toLowerCase()]);
const escText = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = s => escText(s).replace(/"/g, '&quot;');
const kebab = k => k.replace(/[A-Z]/g, c => '-' + c.toLowerCase());
const domError = name => Object.assign(new Error(name), { name });
const indexOf = node => node.parentNode ? node.parentNode.childNodes.indexOf(node) : 0;
const rootOf = node => { while (node.parentNode) node = node.parentNode; return node; };
const nodeLength = node => node.nodeType === 3 || node.nodeType === 8 ? node.data.length : node.childNodes.length;
const ancestry = node => { const chain = []; for (let n = node; n; n = n.parentNode) chain.unshift(n); return chain; };
function precedes(a, b) { // a is preceding b in tree order (same root)
  if (a === b) return false;
  const pa = ancestry(a), pb = ancestry(b); let i = 0;
  while (i < pa.length && i < pb.length && pa[i] === pb[i]) i++;
  if (i === pa.length) return true; if (i === pb.length) return false;
  return indexOf(pa[i]) < indexOf(pb[i]);
}
function position(nodeA, offsetA, nodeB, offsetB) { // DOM §5.2 boundary point position: -1 before, 0 equal, 1 after
  if (nodeA === nodeB) return Math.sign(offsetA - offsetB);
  if (precedes(nodeB, nodeA)) return -position(nodeB, offsetB, nodeA, offsetA);
  if (nodeA.contains(nodeB)) { let child = nodeB; while (child.parentNode !== nodeA) child = child.parentNode; if (indexOf(child) < offsetA) return 1; }
  return -1;
}
// DOM §4.2.3 "remove": boundary points inside the removed node move to (parent, index);
// later offsets in parent shift down.
function removeNode(node) {
  const parent = node.parentNode, doc = node.ownerDocument, index = indexOf(node);
  for (const r of doc.ranges) {
    if (node.contains(r.sc)) r.set('start', parent, index);
    if (node.contains(r.ec)) r.set('end', parent, index);
    if (r.sc === parent && r.so > index) r.set('start', parent, r.so - 1);
    if (r.ec === parent && r.eo > index) r.set('end', parent, r.eo - 1);
  }
  if (parent.isConnected) { doc.record('remove', parent, node); if (node.contains(doc.activeElement)) doc.activeElement = doc.body; }
  parent.childNodes.splice(index, 1); node.parentNode = null;
}
// DOM §4.2.3 "insert": offsets after the reference child shift up by count; each node is
// adopted (removed from its old parent) before insertion.
function insertNode(parent, node, child) {
  const doc = parent.ownerDocument, nodes = node.nodeType === 11 ? [...node.childNodes] : [node];
  if (!nodes.length) return;
  if (node.nodeType === 11) for (const n of nodes) removeNode(n);
  if (child) { const index = indexOf(child); for (const r of doc.ranges) { if (r.sc === parent && r.so > index) r.set('start', parent, r.so + nodes.length); if (r.ec === parent && r.eo > index) r.set('end', parent, r.eo + nodes.length); } }
  for (const n of nodes) {
    if (n.parentNode) removeNode(n);
    parent.childNodes.splice(child ? indexOf(child) : parent.childNodes.length, 0, n); n.parentNode = parent;
    if (parent.isConnected) { doc.record('insert', parent, n); doc.inserted(n); }
  }
}
function preInsert(parent, node, child) {
  if (child && child.parentNode !== parent) throw domError('NotFoundError');
  insertNode(parent, node, child === node ? node.nextSibling : child); return node;
}
function replaceAll(parent, node) { for (const child of [...parent.childNodes]) removeNode(child); if (node) insertNode(parent, node, null); }
// DOM §4.10 "replace data": boundary points inside (offset, offset + count] collapse to
// offset; those after it shift by data.length - count. Setting data/nodeValue/textContent
// is replace data (0, length, value) - the mechanism that collapses a selection to 0.
function replaceData(node, offset, count, data) {
  const doc = node.ownerDocument, length = node.data.length;
  if (offset > length) throw domError('IndexSizeError');
  if (offset + count > length) count = length - offset;
  node._data = node._data.slice(0, offset) + data + node._data.slice(offset + count);
  for (const r of doc.ranges) {
    if (r.sc === node && r.so > offset && r.so <= offset + count) r.set('start', node, offset);
    if (r.ec === node && r.eo > offset && r.eo <= offset + count) r.set('end', node, offset);
    if (r.sc === node && r.so > offset + count) r.set('start', node, r.so + data.length - count);
    if (r.ec === node && r.eo > offset + count) r.set('end', node, r.eo + data.length - count);
  }
  if (node.isConnected) doc.record('text', node.parentNode, node);
}

class FakeNode {
  constructor(doc) { this.ownerDocument = doc; this.parentNode = null; this.childNodes = []; }
  get parentElement() { return this.parentNode?.nodeType === 1 ? this.parentNode : null; }
  get firstChild() { return this.childNodes[0] || null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
  get nextSibling() { const s = this.parentNode?.childNodes; return s ? s[s.indexOf(this) + 1] || null : null; }
  get previousSibling() { const s = this.parentNode?.childNodes; return s ? s[s.indexOf(this) - 1] || null : null; }
  get isConnected() { return rootOf(this) === this.ownerDocument; }
  get textContent() { return this.childNodes.map(c => c.nodeType === 8 ? '' : c.textContent).join(''); }
  set textContent(v) { v = String(v); replaceAll(this, v ? new FakeText(this.ownerDocument, v) : null); }
  contains(node) { for (let n = node; n; n = n.parentNode) if (n === this) return true; return false; }
  insertBefore(node, child) { return preInsert(this, node, child ?? null); }
  appendChild(node) { return preInsert(this, node, null); }
  append(...nodes) { for (const n of nodes) this.appendChild(typeof n === 'string' ? new FakeText(this.ownerDocument, n) : n); }
  removeChild(node) { if (node.parentNode !== this) throw domError('NotFoundError'); removeNode(node); return node; }
  remove() { if (this.parentNode) removeNode(this); }
  replaceWith(node) { const parent = this.parentNode; preInsert(parent, node, this); removeNode(this); }
  cloneNode(deep = false) { const copy = this.cloneShallow(); if (deep) for (const child of this.childNodes) { const c = child.cloneNode(true); copy.childNodes.push(c); c.parentNode = copy; } return copy; }
}
class FakeCharacterData extends FakeNode {
  constructor(doc, data) { super(doc); this._data = String(data); }
  get data() { return this._data; } set data(v) { replaceData(this, 0, this._data.length, String(v)); }
  get nodeValue() { return this._data; } set nodeValue(v) { this.data = v; }
  get textContent() { return this._data; } set textContent(v) { this.data = v; }
  get length() { return this._data.length; }
  insertData(offset, data) { replaceData(this, offset, 0, String(data)); }
  deleteData(offset, count) { replaceData(this, offset, count, ''); }
  appendData(data) { replaceData(this, this._data.length, 0, String(data)); }
  replaceData(offset, count, data) { replaceData(this, offset, count, String(data)); }
}
class FakeText extends FakeCharacterData { constructor(doc, data) { super(doc, data); this.nodeType = 3; this.nodeName = '#text'; } cloneShallow() { return new FakeText(this.ownerDocument, this._data); } }
class FakeComment extends FakeCharacterData { constructor(doc, data) { super(doc, data); this.nodeType = 8; this.nodeName = '#comment'; } cloneShallow() { return new FakeComment(this.ownerDocument, this._data); } }
class FakeFragment extends FakeNode {
  constructor(doc) { super(doc); this.nodeType = 11; this.nodeName = '#document-fragment'; }
  cloneShallow() { return new FakeFragment(this.ownerDocument); }
  querySelector(s) { return this.querySelectorAll(s)[0] || null; }
  querySelectorAll(s) { return select(this, s); }
}
class FakeElement extends FakeNode {
  constructor(doc, tag) {
    super(doc); this.nodeType = 1; this.tagName = tag.toUpperCase(); this.nodeName = this.tagName; this.attrs = new Map();
    this.style = {}; this.scrollTop = 0; this._value = null; this.selectionStart = 0; this.selectionEnd = 0; this.valueWrites = 0;
    if (this.tagName === 'TEMPLATE') this.content = new FakeFragment(doc);
    const el = this;
    this.dataset = new Proxy({}, {
      get: (_, k) => typeof k === 'string' ? el.getAttribute('data-' + kebab(k)) ?? undefined : undefined,
      set: (_, k, v) => { el.setAttribute('data-' + kebab(k), v); return true; },
      deleteProperty: (_, k) => { el.removeAttribute('data-' + kebab(k)); return true; },
      has: (_, k) => el.hasAttribute('data-' + kebab(k)),
    });
  }
  cloneShallow() { const copy = this.ownerDocument.createElement(this.localName); for (const [k, v] of this.attrs) copy.attrs.set(k, v); return copy; }
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
  set value(v) { this._value = String(v); this.valueWrites++; this.selectionStart = this.selectionEnd = this._value.length; }
  setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
  focus() { this.ownerDocument.focus(this); }
  blur() { if (this.ownerDocument.activeElement === this) this.ownerDocument.focus(this.ownerDocument.body); }
  scrollIntoView() {}
  get children() { return this.childNodes.filter(n => n.nodeType === 1); }
  get innerHTML() { return this.childNodes.map(serialize).join(''); }
  set innerHTML(html) {
    const holder = new FakeFragment(this.ownerDocument); parseInto(this.ownerDocument, String(html), holder);
    if (this.tagName === 'TEMPLATE') { replaceAll(this.content, holder); return; }
    if (this.id === 'main') this.ownerDocument.counters.mainInnerHTML++;
    replaceAll(this, holder);
  }
  set outerHTML(html) { const holder = new FakeFragment(this.ownerDocument); parseInto(this.ownerDocument, String(html), holder); const parent = this.parentNode; preInsert(parent, holder, this); removeNode(this); }
  matches(s) { return compile(s).some(parts => matchParts(this, parts, parts.length - 1)); }
  closest(s) { for (let n = this; n?.nodeType === 1; n = n.parentNode) if (n.matches(s)) return n; return null; }
  querySelector(s) { return this.querySelectorAll(s)[0] || null; }
  querySelectorAll(s) { return select(this, s); }
  requestSubmit() { this.ownerDocument.dispatch('submit', { target: this }); }
  get form() { return this.closest('form'); }
  get selectedOptions() { return select(this, 'option').filter(o => o.hasAttribute('selected')); }
}
// DOM §5.5 live Range. Every Range created by document.createRange() is live.
class FakeRange {
  constructor(doc) { this.doc = doc; this.sc = doc; this.so = 0; this.ec = doc; this.eo = 0; doc.ranges.add(this); }
  get startContainer() { return this.sc; } get startOffset() { return this.so; }
  get endContainer() { return this.ec; } get endOffset() { return this.eo; }
  get collapsed() { return this.sc === this.ec && this.so === this.eo; }
  get commonAncestorContainer() { let c = this.sc; while (!c.contains(this.ec)) c = c.parentNode; return c; }
  set(which, node, offset) { // internal boundary update used by the mutation algorithms
    const key = which === 'start' ? ['sc', 'so'] : ['ec', 'eo'];
    if (this[key[0]] === node && this[key[1]] === offset) return;
    this[key[0]] = node; this[key[1]] = offset;
    if (this.doc.selection.range === this) this.doc.queueSelectionChange();
  }
  boundary(which, node, offset) { // "set the start or end"
    if (offset > nodeLength(node)) throw domError('IndexSizeError');
    if (which === 'start') { if (rootOf(this.sc) !== rootOf(node) || position(node, offset, this.ec, this.eo) > 0) this.set('end', node, offset); this.set('start', node, offset); }
    else { if (rootOf(this.sc) !== rootOf(node) || position(node, offset, this.sc, this.so) < 0) this.set('start', node, offset); this.set('end', node, offset); }
  }
  setStart(node, offset) { this.boundary('start', node, offset); }
  setEnd(node, offset) { this.boundary('end', node, offset); }
  selectNodeContents(node) { this.set('start', node, 0); this.set('end', node, nodeLength(node)); }
  collapse(toStart = false) { if (toStart) this.set('end', this.sc, this.so); else this.set('start', this.ec, this.eo); }
  cloneRange() { const r = new FakeRange(this.doc); r.sc = this.sc; r.so = this.so; r.ec = this.ec; r.eo = this.eo; return r; }
  contains(node) { return rootOf(node) === rootOf(this.sc) && position(node, 0, this.sc, this.so) > 0 && position(node, nodeLength(node), this.ec, this.eo) < 0; }
  toString() {
    const { sc, so, ec, eo } = this;
    if (sc === ec && sc.nodeType === 3) return sc.data.slice(so, eo);
    let s = sc.nodeType === 3 ? sc.data.slice(so) : '';
    const walk = n => { for (const c of n.childNodes) { if (c.nodeType === 3 && this.contains(c)) s += c.data; walk(c); } };
    walk(this.commonAncestorContainer);
    return s + (ec.nodeType === 3 ? ec.data.slice(0, eo) : '');
  }
  intersectsNode(node) {
    if (rootOf(node) !== rootOf(this.sc)) return false;
    const parent = node.parentNode; if (!parent) return true;
    const offset = indexOf(node);
    return position(parent, offset, this.ec, this.eo) < 0 && position(parent, offset + 1, this.sc, this.so) > 0;
  }
  comparePoint(node, offset) {
    if (rootOf(node) !== rootOf(this.sc)) throw domError('WrongDocumentError');
    if (offset > nodeLength(node)) throw domError('IndexSizeError');
    return position(node, offset, this.sc, this.so) < 0 ? -1 : position(node, offset, this.ec, this.eo) > 0 ? 1 : 0;
  }
  isPointInRange(node, offset) { return rootOf(node) === rootOf(this.sc) && this.comparePoint(node, offset) === 0; }
}
// Selection API: one live range; anchor/focus follow its boundary points.
class FakeSelection {
  constructor(doc) { this.doc = doc; this.range = null; this.forward = true; }
  get rangeCount() { return this.range ? 1 : 0; }
  get isCollapsed() { return !this.range || this.range.collapsed; }
  get type() { return !this.range ? 'None' : this.range.collapsed ? 'Caret' : 'Range'; }
  get anchorNode() { return this.range ? (this.forward ? this.range.sc : this.range.ec) : null; }
  get anchorOffset() { return this.range ? (this.forward ? this.range.so : this.range.eo) : 0; }
  get focusNode() { return this.range ? (this.forward ? this.range.ec : this.range.sc) : null; }
  get focusOffset() { return this.range ? (this.forward ? this.range.eo : this.range.so) : 0; }
  getRangeAt(i) { if (i !== 0 || !this.range) throw domError('IndexSizeError'); return this.range; }
  removeAllRanges() { if (!this.range) return; this.range = null; this.doc.queueSelectionChange(); }
  addRange(range) { if (this.range || rootOf(range.sc) !== this.doc) return; this.range = range; this.forward = true; this.doc.queueSelectionChange(); }
  setBaseAndExtent(anchor, anchorOffset, focus, focusOffset) {
    const r = new FakeRange(this.doc); this.forward = position(anchor, anchorOffset, focus, focusOffset) <= 0;
    if (this.forward) { r.setStart(anchor, anchorOffset); r.setEnd(focus, focusOffset); } else { r.setStart(focus, focusOffset); r.setEnd(anchor, anchorOffset); }
    this.range = r; this.doc.queueSelectionChange();
  }
  selectAllChildren(node) { const r = new FakeRange(this.doc); r.selectNodeContents(node); this.range = r; this.forward = true; this.doc.queueSelectionChange(); }
  toString() { return this.range ? this.range.toString() : ''; }
}
function serialize(node) {
  if (node.nodeType === 3) return escText(node.data);
  if (node.nodeType === 8) return `<!--${node.data}-->`;
  const attrs = [...node.attrs].map(([k, v]) => ` ${k}="${escAttr(v)}"`).join('');
  return VOID.has(node.localName) ? `<${node.localName}${attrs}>` : `<${node.localName}${attrs}>${node.childNodes.map(serialize).join('')}</${node.localName}>`;
}
function parseInto(doc, html, root) { // builds a fresh detached tree (no live range can point into it yet)
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
    super(null); this.ownerDocument = this; this.nodeType = 9; this.nodeName = '#document'; this.listeners = new Map(); this.log = [];
    this.ranges = new Set(); this.selection = new FakeSelection(this); this.selectionChanges = 0; this.selectionQueued = false;
    this.counters = { mainInnerHTML: 0, homeMainInserted: 0 };
    parseInto(this, shell, this);
    this.documentElement = this.childNodes.find(n => n.nodeType === 1); this.body = this.querySelector('body'); this.activeElement = this.body;
  }
  get isConnected() { return true; }
  record(type, target, node) { this.log.push({ type, target, node }); }
  inserted(node) { const visit = n => { if (n.nodeType !== 1) return; if (n.classList.contains('home-main')) this.counters.homeMainInserted++; n.childNodes.forEach(visit); }; visit(node); }
  createElement(tag) { return new FakeElement(this, tag); }
  createTextNode(data) { return new FakeText(this, data); }
  createRange() { return new FakeRange(this); }
  getSelection() { return this.selection; }
  queueSelectionChange() { // Selection API: a selectionchange task is queued (once) per change burst
    if (this.selectionQueued) return; this.selectionQueued = true;
    setImmediate(() => { this.selectionQueued = false; this.selectionChanges++; this.dispatch('selectionchange', { target: this }); });
  }
  getElementById(id) { return this.querySelector('#' + id); }
  querySelector(s) { return this.querySelectorAll(s)[0] || null; }
  querySelectorAll(s) { return select(this, s); }
  addEventListener(type, callback) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(callback); }
  removeEventListener() {}
  dispatch(type, init) { const event = { type, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...init }; for (const cb of this.listeners.get(type) || []) cb(event); return event; }
  focus(el) { if (!el?.isConnected || this.activeElement === el) return; const previous = this.activeElement; this.activeElement = el; if (previous && previous !== this.body) this.dispatch('focusout', { target: previous, relatedTarget: el }); this.dispatch('focusin', { target: el, relatedTarget: previous }); }
}

// ---------------------------------------------------------------- synthetic local server
function makeServer() {
  const s = { tick: 0, requests: [], tasks: [], details: new Map(), approvals: [], localDown: false, local: { mode: 'confirm', revision: 1, pending: [], operations: [] } };
  const clone = v => JSON.parse(JSON.stringify(v));
  s.count = prefix => s.requests.filter(r => r.startsWith(prefix)).length;
  s.state = () => ({
    settings: { mode: 'demo', budget: 20, heartbeat: true },
    system: { name: '路衡办公智能体', version: '0.5.1', heartbeat: true, lastHeartbeat: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, 500 * ++s.tick)).toISOString() },
    tasks: clone(s.tasks), schedules: [], agents: [{ id: 'coordinator', name: '办公助手', enabled: true, permissions: ['knowledge.read'] }], memories: [], reminders: [], audit: [], approvals: clone(s.approvals),
    notifications: [], mail: [], mailAccounts: [], mailOutbox: [], mailApprovals: [], realInbox: [], browserTargets: [], controlledSessions: [], browserApprovals: [], desktop: { available: false },
    localAccess: { summariesOnly: true, mode: s.local.mode },
  });
  s.fetch = async (path, options = {}) => {
    const method = options.method || 'GET'; s.requests.push(method === 'GET' ? path : method + ' ' + path);
    const ok = body => ({ ok: true, status: 200, json: async () => body }), fail = status => ({ ok: false, status, json: async () => ({ error: 'synthetic unavailable' }) });
    if (path === '/api/state') return ok(s.state());
    if (path === '/api/local-access/state') return s.localDown ? fail(503) : ok({ localAccess: { mode: s.local.mode, configured: true, roots: ['/synthetic/root'], allFiles: false, platform: 'win32', revision: s.local.revision, pending: clone(s.local.pending), operations: clone(s.local.operations) } });
    const m = path.match(/^\/api\/tasks\/([^/]+)$/);
    if (method === 'GET' && m && s.details.has(decodeURIComponent(m[1]))) return ok(clone(s.details.get(decodeURIComponent(m[1]))));
    return fail(404);
  };
  return s;
}

const bootstrap = 'renderChrome();loadState();setInterval(()=>loadState(),2000);';
assert.equal(source.split(bootstrap).length, 2, 'the shipped bootstrap is present exactly once and runs unchanged');

async function boot({ server = makeServer(), activeChat = null } = {}) {
  const doc = new FakeDocument(), timers = new Map(), storage = new Map();
  if (activeChat) storage.set('luheng-active-chat', activeChat);
  let now = 0, serial = 0;
  const win = { scrollY: 0, scrollTo(opts) { win.scrollY = typeof opts === 'object' ? opts.top ?? 0 : opts; }, addEventListener() {}, getSelection: () => doc.getSelection() };
  class FakeFormData { constructor(form) { this.values = {}; for (const el of form.querySelectorAll('textarea,select,input')) if (el.name) this.values[el.name] = el.value; } get(k) { return this.values[k] ?? null; } }
  const context = vm.createContext({
    document: doc, window: win, location: { hash: '' }, navigator: { platform: 'Win32', clipboard: { writeText: async () => {} } },
    sessionStorage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)), removeItem: k => storage.delete(k) },
    fetch: server.fetch, AbortController, FormData: FakeFormData, URL, console, crypto: webcrypto, CSS: { escape: v => String(v) },
    getSelection: () => doc.getSelection(),
    setTimeout: (cb, ms = 0) => { const id = ++serial; timers.set(id, { cb, due: now + ms }); return id; },
    clearTimeout: id => timers.delete(id),
    setInterval: (cb, ms) => { const id = ++serial; timers.set(id, { cb, due: now + ms, every: ms }); return id; },
    clearInterval: id => timers.delete(id),
  });
  const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(r => setImmediate(r)); };
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
  const $ = s => doc.querySelector(s), main = $('#main'), selection = doc.getSelection();
  const f = { doc, server, context, win, $, main, settle, advance, selection };
  f.poll = async (n = 1, each) => { for (let i = 0; i < n; i++) { await advance(2000); if (each) await each(i); } };
  f.click = el => doc.dispatch('click', { target: el });
  f.mark = () => doc.log.length;
  f.opsIn = (since, region) => doc.log.slice(since).filter(r => region.contains(r.target) || r.target === region).length;
  f.mainOps = since => doc.log.slice(since).filter(r => main.contains(r.target)).length;
  f.select = (node, start, end = start) => { selection.setBaseAndExtent(node, start, node, end); };
  f.sel = () => ({ anchorNode: selection.anchorNode, anchorOffset: selection.anchorOffset, focusNode: selection.focusNode, focusOffset: selection.focusOffset, isCollapsed: selection.isCollapsed, text: selection.toString() });
  return f;
}
const same = (actual, expected, message = 'expected the same DOM node') => assert.ok(actual === expected, message);
const metric = (name, values) => console.log(`METRIC ${name} ${Object.entries(values).map(([k, v]) => `${k}=${typeof v === 'string' ? JSON.stringify(v) : v}`).join(' ')}`);
const answer = f => f.$('[data-key="output:t1"]') || f.$('.task-result'); // the baseline build has no answer key
const baseTask = extra => ({ id: 't1', title: '整理养护周报', prompt: '汇总巡查记录并形成周报', status: 'running', agentId: 'coordinator', createdAt: '2026-01-01T00:00:00.000Z', budget: 40, budgetUsed: 1, steps: [{ name: '步骤-1', status: 'completed' }], ...extra });
const stepsShown = f => f.$('.execution-disclosure summary span')?.textContent || '';

// ---------------------------------------------------------------- fixture self-check
// rangeProbe uses only standard DOM APIs; evidence/selection-browser.mjs runs the same
// function in real Chromium and compares the observations with this fixture.
export function rangeProbe(document) {
  const out = [], sel = document.getSelection(), host = document.createElement('div'); document.body.appendChild(host);
  const p = document.createElement('p'); host.appendChild(p);
  const t = document.createTextNode('ABSTRACT: RESULT THAT MATTERS.'); p.appendChild(t);
  const name = n => n === t ? 't' : n === p ? 'p' : n === host ? 'host' : String(n?.nodeName);
  const snap = label => out.push([label, name(sel.anchorNode), sel.anchorOffset, name(sel.focusNode), sel.focusOffset, sel.isCollapsed, sel.rangeCount ? sel.getRangeAt(0).toString() : null]);
  sel.setBaseAndExtent(t, 10, t, 20); snap('select 10..20');
  t.nodeValue = t.data + ' NEXT'; snap('nodeValue rewrite = replace data (0, length)');
  sel.setBaseAndExtent(t, 10, t, 20); t.insertData(t.length, ' MORE'); snap('insertData at the end');
  t.insertData(20, '#'); snap('insertData at the end boundary');
  t.insertData(0, '>> '); snap('insertData before the selection');
  t.insertData(13, '!'); snap('insertData at the start boundary');
  t.deleteData(13, 1); snap('deleteData at the start boundary');
  t.replaceData(0, 13, 'X'); snap('replaceData ending at the start boundary');
  sel.setBaseAndExtent(t, 1, t, 11); t.insertData(0, 'YY'); t.deleteData(2, 1); snap('insertData then deleteData across the start boundary');
  const em = document.createElement('em'); em.textContent = 'EM'; p.appendChild(em);
  sel.setBaseAndExtent(em.firstChild, 0, em.firstChild, 2); snap('select inside <em>');
  p.removeChild(em); snap('remove the boundary container');
  sel.setBaseAndExtent(p, 0, p, 1); snap('select the text node');
  p.insertBefore(document.createTextNode('IN'), t); snap('insert a node at the start boundary');
  p.appendChild(document.createTextNode('OUT')); snap('append a node at the end boundary');
  p.insertBefore(t, null); snap('move the selected node');
  const r = document.createRange(); r.setStart(p.childNodes[0], 1); r.setEnd(p.childNodes[0], 2);
  out.push(['intersectsNode/comparePoint', r.intersectsNode(p.childNodes[0]), r.intersectsNode(p), r.intersectsNode(p.childNodes[1]), r.comparePoint(p, 0), r.comparePoint(p.childNodes[0], 1), r.comparePoint(p, p.childNodes.length)]);
  const wrap = document.createElement('div'), copy = p.cloneNode(true); wrap.appendChild(copy);
  const trial = document.createRange(); trial.setStart(copy.childNodes[0], 1); trial.setEnd(wrap, 1); const before = trial.toString();
  copy.appendChild(document.createTextNode('Z'));
  out.push(['detached clone range', before, trial.toString(), trial.collapsed]);
  host.remove(); sel.removeAllRanges();
  return out;
}
test('fixture: live Range/Selection follow the DOM insert, remove and replace-data rules', () => {
  const observed = rangeProbe(new FakeDocument());
  console.log('PROBE ' + JSON.stringify(observed));
  const D = 'YYRESULT THA#T MATTERS. NEXT MORE'; // the text after the edits above
  assert.deepEqual(observed, [
    ['select 10..20', 't', 10, 't', 20, false, 'RESULT THA'],
    ['nodeValue rewrite = replace data (0, length)', 't', 0, 't', 0, true, ''],
    ['insertData at the end', 't', 10, 't', 20, false, 'RESULT THA'],
    ['insertData at the end boundary', 't', 10, 't', 20, false, 'RESULT THA'],
    ['insertData before the selection', 't', 13, 't', 23, false, 'RESULT THA'],
    ['insertData at the start boundary', 't', 13, 't', 24, false, '!RESULT THA'],
    ['deleteData at the start boundary', 't', 13, 't', 23, false, 'RESULT THA'],
    ['replaceData ending at the start boundary', 't', 0, 't', 11, false, 'XRESULT THA'],
    ['insertData then deleteData across the start boundary', 't', 2, 't', 12, false, 'RESULT THA'],
    ['select inside <em>', '#text', 0, '#text', 2, false, 'EM'],
    ['remove the boundary container', 'p', 1, 'p', 1, true, ''],
    ['select the text node', 'p', 0, 'p', 1, false, D],
    ['insert a node at the start boundary', 'p', 0, 'p', 2, false, 'IN' + D],
    ['append a node at the end boundary', 'p', 0, 'p', 2, false, 'IN' + D],
    ['move the selected node', 'p', 0, 'p', 1, false, 'IN'],
    ['intersectsNode/comparePoint', true, true, false, -1, 0, 1],
    ['detached clone range', 'NOUT' + D, 'NOUT' + D + 'Z', false],
  ]);
});

// ---------------------------------------------------------------- app contract
test('appending to the selected answer keeps the Range endpoints and selected text; steps, budget and badge keep updating', async () => {
  const server = makeServer(), task = baseTask({ output: 'ABSTRACT: RESULT THAT MATTERS.' }); server.tasks = [task];
  const f = await boot({ server, activeChat: 't1' });
  const block = answer(f), text = block.firstChild, prompt = f.$('#prompt-input'), article = f.$('.task-detail'), homeMain = f.$('.home-main');
  assert.equal(text.data.slice(10, 20), 'RESULT THA');
  f.select(text, 10, 20); await f.settle();
  const mark = f.mark(); let lost = 0, staleSteps = 0, staleAnswer = 0;
  await f.poll(10, async i => {
    const s = f.sel(); if (s.anchorNode !== text || s.focusNode !== text || s.anchorOffset !== 10 || s.focusOffset !== 20 || s.isCollapsed || s.text !== 'RESULT THA') lost++;
    if (i && !stepsShown(f).includes(`${task.steps.length} 个步骤`)) staleSteps++;
    if (i && !answer(f).textContent.endsWith(`追加的结论 ${i + 1}`)) staleAnswer++;
    task.output += `\n第 ${i + 2} 段：追加的结论 ${i + 2}`; task.steps.push({ name: '步骤-' + (i + 2), status: 'completed' }); task.budgetUsed = i + 2;
    if (i === 9) task.status = 'completed';
  });
  await f.poll(1);
  const s = f.sel();
  metric('append', { polls: 11, selectionLost: lost, anchorOffset: s.anchorOffset, focusOffset: s.focusOffset, isCollapsed: s.isCollapsed, text: s.text, textNodeSame: answer(f).firstChild === text, blockSame: answer(f) === block, staleSteps, staleAnswer, mainInnerHTML: f.doc.counters.mainInnerHTML, homeMainInserted: f.doc.counters.homeMainInserted, answerOps: f.opsIn(mark, block) });
  same(s.anchorNode, text, 'anchor stays in the selected text node'); same(s.focusNode, text, 'focus stays in the selected text node');
  assert.deepEqual([s.anchorOffset, s.focusOffset, s.isCollapsed, s.text], [10, 20, false, 'RESULT THA'], 'Range endpoints and selected text survive every append');
  assert.equal(lost, 0, 'the selection held on every poll'); assert.equal(text.isConnected, true);
  same(answer(f), block, 'answer block kept'); same(f.$('.task-detail'), article, 'task message kept'); same(f.$('#prompt-input'), prompt, 'composer kept'); same(f.$('.home-main'), homeMain);
  assert.match(answer(f).textContent, /第 11 段：追加的结论 11$/, 'every appended paragraph is shown');
  assert.equal(staleSteps + staleAnswer, 0, 'answer and steps were current on every poll');
  assert.match(stepsShown(f), /11 个步骤/); assert.match(f.$('.detail-meta').textContent, /预算 11 \/ 40 步/); assert.match(f.$('.task-detail .badge').textContent, /已完成/);
  assert.equal(f.doc.counters.mainInnerHTML, 1, 'only the first load mounted #main');
});

test('a format change after the selection (bold closes, heading line) applies at once and keeps the selection', async () => {
  const server = makeServer(), task = baseTask({ output: 'ABSTRACT: RESULT THAT MATTERS.\nNext: use **bo' }); server.tasks = [task];
  const f = await boot({ server, activeChat: 't1' });
  const block = answer(f), text = block.firstChild;
  f.select(text, 10, 20); await f.settle();
  task.output += 'ld** words\n## 下一步\n继续巡查'; task.steps.push({ name: '步骤-2', status: 'running' });
  await f.poll(1);
  const s = f.sel();
  metric('format-after', { anchorOffset: s.anchorOffset, focusOffset: s.focusOffset, isCollapsed: s.isCollapsed, text: s.text, strong: answer(f).querySelector('strong')?.textContent, heading: answer(f).querySelector('h3')?.textContent, blockSame: answer(f) === block });
  same(s.anchorNode, text); same(s.focusNode, text);
  assert.deepEqual([s.anchorOffset, s.focusOffset, s.isCollapsed, s.text], [10, 20, false, 'RESULT THA']);
  same(answer(f), block, 'answer block kept');
  assert.equal(answer(f).querySelector('strong')?.textContent, 'bold', 'the closed bold is rendered on this poll');
  assert.equal(answer(f).querySelector('h3')?.textContent, '下一步', 'the heading line is rendered on this poll');
  assert.match(stepsShown(f), /2 个步骤/);
});

test('a format change that rewrites the selected text holds only the answer; progress, approvals and permissions keep updating; it catches up once the selection leaves', async () => {
  const server = makeServer(), task = baseTask({ output: 'Intro line\nKey: **RESULT THA' }); server.tasks = [task];
  const f = await boot({ server, activeChat: 't1' });
  const block = answer(f), text = block.firstChild, prompt = f.$('#prompt-input'), pill = f.$('#local-access-toggle'), start = text.data.indexOf('RESULT THA');
  f.select(text, start, start + 10); await f.settle();
  const shown = block.textContent, mark = f.mark();
  task.output += 'T MATTERS** confirmed.'; task.steps.push({ name: '步骤-2', status: 'completed' }); task.budgetUsed = 2;
  server.approvals = [{ id: 'a1', taskId: 't1', status: 'pending', type: 'workspace.write', summary: '写入周报需要确认' }];
  server.local.revision++; server.local.mode = 'read_only';
  await f.poll(1);
  let s = f.sel();
  const held = { anchorOffset: s.anchorOffset, focusOffset: s.focusOffset, isCollapsed: s.isCollapsed, text: s.text, answerUnchanged: answer(f).textContent === shown, strong: !!answer(f).querySelector('strong'), steps: stepsShown(f), approval: !!f.$('[data-key="approval:a1"]'), pill: f.$('#local-access-toggle span').textContent };
  metric('format-in-selection-held', held);
  same(s.anchorNode, text); same(s.focusNode, text);
  assert.deepEqual([s.anchorOffset, s.focusOffset, s.isCollapsed, s.text], [start, start + 10, false, 'RESULT THA'], 'the selection is not torn down or emptied');
  assert.equal(answer(f).textContent, shown, 'only the affected answer region waits'); assert.equal(f.opsIn(mark, block), 0);
  assert.match(stepsShown(f), /2 个步骤/, 'steps keep updating'); assert.match(f.$('.detail-meta').textContent, /预算 2 \/ 40 步/);
  assert.match(f.$('[data-key="approval:a1"]')?.textContent || '', /写入周报需要确认/, 'a new approval is shown at once');
  assert.equal(f.$('#local-access-toggle span').textContent, '只读访问', 'the permission pill shows the new revision'); same(f.$('#local-access-toggle'), pill); same(f.$('#prompt-input'), prompt);
  // More growth, an approval cleared, and idle heartbeats: still held, nothing rewritten.
  task.output += '\n后续 1'; server.approvals = []; await f.poll(1);
  assert.equal(f.$('[data-key="approval:a1"]'), null, 'a resolved approval disappears at once');
  const idleMark = f.mark(), before = { main: f.doc.counters.mainInnerHTML, home: f.doc.counters.homeMainInserted };
  await f.poll(30);
  s = f.sel();
  metric('held-idle', { polls: 30, mainOps: f.mainOps(idleMark), mainInnerHTML: f.doc.counters.mainInnerHTML - before.main, homeMainInserted: f.doc.counters.homeMainInserted - before.home, text: s.text });
  assert.equal(f.mainOps(idleMark), 0, 'idle polls while held write nothing'); assert.equal(f.doc.counters.homeMainInserted - before.home, 0);
  assert.deepEqual([s.anchorOffset, s.focusOffset, s.text], [start, start + 10, 'RESULT THA']);
  // Clearing the selection catches up right away, without waiting for a poll.
  const requests = server.count('/api/state');
  f.selection.removeAllRanges(); await f.settle();
  metric('cleared-catch-up', { statePollsDuringCatchUp: server.count('/api/state') - requests, strong: answer(f).querySelector('strong')?.textContent ?? null, blockSame: answer(f) === block });
  assert.equal(server.count('/api/state') - requests, 0, 'catch-up did not wait for a poll');
  assert.equal(answer(f).querySelector('strong')?.textContent, 'RESULT THAT MATTERS', 'the latest answer is shown once the selection is cleared');
  assert.match(answer(f).textContent, /confirmed\.\n后续 1$/); same(answer(f), block, 'the answer block itself was kept');
  // Hold again on a new streaming bold, then narrow the selection to an untouched part
  // (still inside the answer, so no selectionchange catch-up): the next poll applies it.
  task.output += ' **NEXT PA'; await f.poll(1);
  const tail = answer(f).lastChild, at = tail.data.indexOf('NEXT');
  f.select(tail, at, at + 4); await f.settle();
  task.output += 'RT** end'; await f.poll(1);
  assert.equal(f.sel().text, 'NEXT', 'held again'); assert.equal(answer(f).querySelectorAll('strong').length, 1);
  const intro = answer(f).firstChild; f.select(intro, 0, 5); await f.settle();
  assert.equal(answer(f).querySelectorAll('strong').length, 1, 'still inside the answer: waits for the next poll');
  await f.poll(1);
  s = f.sel();
  metric('narrowed-catch-up', { strongs: answer(f).querySelectorAll('strong').length, text: s.text, anchorOffset: s.anchorOffset, focusOffset: s.focusOffset });
  assert.equal(answer(f).querySelectorAll('strong')[1]?.textContent, 'NEXT PART', 'the next poll applies the held result');
  assert.match(answer(f).textContent, /NEXT PART end$/);
  same(s.anchorNode, intro); assert.deepEqual([s.text, s.anchorOffset, s.focusOffset, s.isCollapsed], ['Intro', 0, 5, false], 'the narrowed selection survives the catch-up');
});

test('a structure change around the answer (queued placeholder removed on completion) keeps the answer node and the selection', async () => {
  const server = makeServer(), task = baseTask({ steps: [], output: 'ABSTRACT: RESULT THAT MATTERS.' }); server.tasks = [task];
  const f = await boot({ server, activeChat: 't1' });
  assert.ok(f.$('.task-detail .compact-empty'), 'active task without steps shows the queued placeholder before the answer');
  const block = answer(f), text = block.firstChild; f.select(text, 10, 20); await f.settle();
  task.status = 'completed'; task.output += '\n完成。'; await f.poll(1);
  const s = f.sel();
  metric('structure-around', { placeholderGone: !f.$('.task-detail .compact-empty'), blockSame: answer(f) === block, anchorOffset: s.anchorOffset, focusOffset: s.focusOffset, isCollapsed: s.isCollapsed, text: s.text });
  assert.equal(f.$('.task-detail .compact-empty'), null); assert.match(f.$('.task-detail .badge').textContent, /已完成/);
  same(answer(f), block, 'the answer node is not moved or replaced'); same(s.anchorNode, text);
  assert.deepEqual([s.anchorOffset, s.focusOffset, s.isCollapsed, s.text], [10, 20, false, 'RESULT THA']);
  assert.match(answer(f).textContent, /完成。$/);
});

test('privacy and permission clears are not delayed by a selection: private detail gone, approval resolved, local runtime gone', async () => {
  const server = makeServer();
  const summary = extra => baseTask({ localContext: true, liveResultAvailable: true, updatedAt: '2026-01-01T00:00:00.000Z', ...extra });
  server.tasks = [summary()]; server.details.set('t1', { ...summary(), output: 'PRIVATE Key: **RESULT THA' });
  server.local.operations = [{ id: 'op-9', kind: 'read', status: 'completed', summary: '读取巡查台账', snapshot: { kind: 'read', path: '/synthetic/root/PRIVATE-LOCAL.txt' }, createdAt: '2026-01-01T00:00:02.000Z' }];
  server.approvals = [{ id: 'a1', taskId: 't1', status: 'pending', type: 'workspace.write', summary: '写入 PRIVATE-APPROVAL 文件需要确认' }];
  const f = await boot({ server, activeChat: 't1' });
  const text = answer(f).firstChild, start = text.data.indexOf('RESULT THA');
  f.select(text, start, start + 10); await f.settle();
  server.details.set('t1', { ...summary(), output: 'PRIVATE Key: **RESULT THAT** done' }); server.tasks = [summary({ updatedAt: '2026-01-01T00:00:01.000Z' })];
  await f.poll(1);
  assert.equal(f.sel().text, 'RESULT THA', 'held while the new private answer still contains what is shown');
  assert.equal(answer(f).querySelector('strong'), null);
  // The runtime restarts: detail is gone and the summary carries only the safe placeholder.
  server.details.delete('t1'); server.tasks = [summary({ liveResultAvailable: false, output: '正文已随重启清除', updatedAt: '2026-01-01T00:00:03.000Z' })];
  await f.poll(1);
  const placeholder = answer(f)?.textContent ?? null, privateLeft = /PRIVATE Key/.test(f.main.textContent);
  // A selected approval summary and a selected local record are removed as soon as they are cleared.
  const approvalText = f.$('[data-key="approval:a1"] p').firstChild; f.select(approvalText, 3, 10); await f.settle();
  server.approvals = []; await f.poll(1);
  const approvalGone = !f.$('[data-key="approval:a1"]') && !/PRIVATE-APPROVAL/.test(f.main.textContent);
  const record = f.$('[data-key="local-record:op-9"]') || f.$('.local-conversation');
  const recordText = [...(function* walk(n) { for (const c of n.childNodes) { if (c.nodeType === 3 && c.data.includes('PRIVATE-LOCAL')) yield c; if (c.nodeType === 1) yield* walk(c); } })(record)][0];
  f.select(recordText, 0, 5); await f.settle();
  server.localDown = true; await f.poll(1);
  const localGone = !f.$('.local-conversation') && !/PRIVATE-LOCAL/.test(f.main.textContent);
  metric('privacy-clears', { placeholder, privateAnswerLeft: privateLeft, approvalGone, localRuntimeGone: localGone, pill: f.$('#local-access-toggle span').textContent });
  assert.equal(placeholder, '正文已随重启清除', 'the placeholder replaces the held private answer on the same poll'); assert.equal(privateLeft, false);
  assert.equal(approvalGone, true, 'a resolved approval is removed despite the selection inside it');
  assert.equal(localGone, true, 'local runtime records are cleared despite the selection inside them'); assert.equal(f.$('#local-access-toggle span').textContent, '权限未连接');
});
