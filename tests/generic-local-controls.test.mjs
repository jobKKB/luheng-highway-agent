import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Source-bound ordinary UI transition contract. The separate Windows browser
// gate must still prove visible clicks through all four modes and revocation.
const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const start = source.indexOf('async function localAccessAction(name,el){');
const end = source.indexOf("\ndocument.addEventListener('click',", start);
assert.ok(start >= 0 && end > start);
const actionSource = source.slice(start, end);

test('nested local permission popover keeps its composer-options ancestor visible', async () => {
  const panel = { hidden: false }, menu = { hidden: true };
  const toggle = { dataset: {}, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } };
  let focused = 0;
  const selected = { focus() { focused++; } };
  const optionsToggle = { attrs: { 'aria-expanded': 'true' }, setAttribute(k, v) { this.attrs[k] = v; } };
  const nodes = new Map([
    ['#composer-options', panel], ['#local-access-menu', menu],
    ['#local-access-menu [aria-checked="true"]', selected],
    ['[data-action="toggle-options"]', optionsToggle],
  ]);
  const context = vm.createContext({ $: selector => nodes.get(selector) });
  vm.runInContext('let optionsOpen=true,localAccessPopoverOpen=false;\n' + actionSource, context);
  await vm.runInContext("localAccessAction('local-toggle',argumentsToggle)", Object.assign(context, { argumentsToggle: toggle }));
  assert.equal(panel.hidden, false, 'opening the child must not hide its ancestor');
  assert.equal(menu.hidden, false); assert.equal(toggle.attrs['aria-expanded'], 'true');
  assert.equal(optionsToggle.attrs['aria-expanded'], 'true');
  assert.equal(vm.runInContext('optionsOpen', context), true); assert.equal(focused, 1);
  await vm.runInContext("localAccessAction('local-toggle',argumentsToggle)", context);
  assert.equal(panel.hidden, false); assert.equal(menu.hidden, true);
  assert.equal(toggle.attrs['aria-expanded'], 'false'); assert.equal(focused, 1);
});
