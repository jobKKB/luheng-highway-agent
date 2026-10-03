import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const start = source.indexOf('function render(force=false){');
const end = source.indexOf('\nfunction chosenAgent()', start);
assert.ok(start >= 0 && end > start);
// Actual source function with a recording dataset setter. This proves the
// redundant attribute-write contract only; Windows MutationObserver/pixels
// still determine real browser behavior under completed conversation polling.
test('same-view render does not reassign main data-view; real view change writes once', () => {
  const assignments = [], values = { view: 'chat' };
  const dataset = new Proxy(values, { set(o, k, v) { assignments.push({ key: k, value: v }); o[k] = v; return true; } });
  const context = vm.createContext({ main: { dataset }, view: 'chat', online: true, loaded: false, renderChrome() {} });
  vm.runInContext(source.slice(start, end), context);
  vm.runInContext('render();render(true)', context);
  assert.deepEqual(assignments, []);
  context.view = 'settings'; vm.runInContext('render();render()', context);
  assert.deepEqual(assignments, [{ key: 'view', value: 'settings' }]);
});
