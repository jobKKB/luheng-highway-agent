import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { chromium } from 'playwright';
import { startServer } from '../server.mjs';

// Real browser, CSS, native DOM selection and wall clock. No fake clock, DOM
// facade, no-sandbox switch, external provider, user's data, or product override.
const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
assert.ok(args.every((a, i) => a === '--require-windows' || a === '--output-dir' || args[i - 1] === '--output-dir'), 'Unknown argument');
if (args.includes('--require-windows')) assert.equal(process.platform, 'win32', 'This CI gate requires actual Windows');
const at = args.indexOf('--output-dir');
if (at >= 0) assert.ok(args[at + 1], '--output-dir requires a path');
const out = resolve(at >= 0 ? args[at + 1] : await mkdtemp(join(tmpdir(), 'luheng-stability-proof-')));
const rel = relative(root, out);
assert.ok(rel && (rel.startsWith('..') || isAbsolute(rel)), 'Evidence must be outside the source tree');
await mkdir(out, { recursive: true });
const owned = await mkdtemp(join(tmpdir(), 'luheng-stability-'));
const docs = join(owned, 'selected'); await mkdir(docs);
const draftText = Array.from({ length: 65 }, (_, i) => `未发送草稿 ${i + 1}：真实浏览器、选区和滚动仅用合成资料`).join('\n');
const report = { status: 'failed', platform: process.platform, commit: process.env.GITHUB_SHA || null, expectedVersion: JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version, sandbox: true, fakeClock: false, checks: [], frames: [], errors: [], scope: 'Owned temporary data; actual local demo engine and live HTTP polling; one synthetic output suffix fixture; no real provider or user data' };
let app, browser, context, page;
const counters = { stateRequests: 0, taskPosts: 0, detailRequests: 0 }, heartbeatValues = new Set();
const check = (name, value = true) => { assert.ok(value, name); report.checks.push(name); console.log('PASS ' + name); };
async function until(fn, name, ms = 30000) {
  const end = performance.now() + ms;
  while (performance.now() < end) { if (await fn()) return; await new Promise(r => setTimeout(r, 100)); }
  throw new Error('Timed out: ' + name);
}
async function shot(name) {
  const filename = name + '.png'; await page.screenshot({ path: join(out, filename), animations: 'disabled' });
  report.frames.push(filename);
}
async function post(path, data) {
  const response = await page.request.post(app.url + path, { data });
  assert.ok(response.ok(), path + ': ' + response.status() + ' ' + await response.text());
  return response.json();
}
async function anchor() {
  await page.evaluate(() => {
    const main = document.querySelector('#main'), prompt = document.querySelector('#prompt-input');
    window.__stability = { main, prompt, form: document.querySelector('#task-form'), home: document.querySelector('.home-main'), thread: document.querySelector('.chat-thread'), roots: [...main.children], value: prompt.value, start: prompt.selectionStart, end: prompt.selectionEnd, scroll: prompt.scrollTop, mutations: 0, rootRemovals: 0, range: null };
    window.__stability.observer = new MutationObserver(records => { const p = window.__stability; p.mutations += records.length; for (const r of records) if (r.target === p.main) p.rootRemovals += r.removedNodes.length; });
    window.__stability.observer.observe(main, { subtree: true, childList: true, characterData: true, attributes: true });
  });
}
async function stable({ focus = true, range = false, idle = false } = {}) {
  const facts = await page.evaluate(({ focus, range }) => {
    const p = window.__stability, prompt = document.querySelector('#prompt-input'), sel = document.getSelection();
    return { main: p.main === document.querySelector('#main'), form: p.form === document.querySelector('#task-form'), home: p.home === document.querySelector('.home-main'), prompt: p.prompt === prompt, roots: p.roots.length === p.main.children.length && p.roots.every((n, i) => n === p.main.children[i]), thread: !p.thread || p.thread === document.querySelector('.chat-thread'), value: prompt.value === p.value, selection: prompt.selectionStart === p.start && prompt.selectionEnd === p.end, scroll: Math.abs(prompt.scrollTop - p.scroll) <= 1, focus: !focus || document.activeElement === prompt, rootRemovals: p.rootRemovals, mutations: p.mutations, range: !range || !!sel.rangeCount && sel.toString() === p.range.text && sel.getRangeAt(0).startContainer === p.range.node && sel.getRangeAt(0).startOffset === p.range.start && sel.getRangeAt(0).endOffset === p.range.end };
  }, { focus, range });
  for (const key of ['main', 'form', 'home', 'prompt', 'roots', 'thread', 'value', 'selection', 'scroll', 'focus', 'range']) assert.equal(facts[key], true, key + ' must survive background updates');
  assert.equal(facts.rootRemovals, 0, 'No main root replacement');
  if (idle) assert.equal(facts.mutations, 0, 'Idle heartbeat polls must write no main DOM');
  return facts;
}
async function draft() {
  await page.locator('#prompt-input').fill(draftText);
  await page.locator('#prompt-input').evaluate(el => { el.focus(); el.setSelectionRange(37, 61, 'forward'); el.scrollTop = Math.min(240, el.scrollHeight - el.clientHeight); });
}
try {
  app = await startServer({ port: 0, dataDir: join(owned, 'app-data'), stepDelay: 550 });
  browser = await chromium.launch({ headless: true, chromiumSandbox: true, executablePath: process.env.HIGHWAY_CHROMIUM_PATH || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined) });
  context = await browser.newContext({ viewport: { width: 1180, height: 812 }, locale: 'zh-CN', recordVideo: { dir: join(out, 'video'), size: { width: 1180, height: 812 } } });
  page = await context.newPage();
  page.on('pageerror', e => report.errors.push(e.message));
  page.on('request', r => { const u = new URL(r.url()); if (u.pathname === '/api/state') counters.stateRequests++; if (u.pathname === '/api/tasks' && r.method() === 'POST') counters.taskPosts++; if (/^\/api\/tasks\/[^/]+$/.test(u.pathname) && r.method() === 'GET') counters.detailRequests++; });
  page.on('response', async r => { if (new URL(r.url()).pathname === '/api/state' && r.ok()) { try { const s = await r.json(); if (s.system?.lastHeartbeat) heartbeatValues.add(s.system.lastHeartbeat); } catch {} } });
  await page.goto(app.url); await page.locator('#prompt-input').waitFor();
  const health = await (await page.request.get(app.url + '/api/health')).json();
  assert.equal(health.version, report.expectedVersion);
  if (await page.locator('.modal').isVisible()) { await page.keyboard.press('Escape'); await page.locator('.modal').waitFor({ state: 'hidden' }); }
  await post('/api/local-access/configure', { mode: 'disabled', onboardingComplete: true });
  await page.waitForTimeout(2500); await page.evaluate(() => document.fonts.ready);
  await draft(); await anchor(); await shot('idle-00');
  const start = performance.now(), requestsAt = counters.stateRequests;
  for (const second of [10, 20, 30, 40, 50, 60]) {
    const remain = start + second * 1000 - performance.now(); if (remain > 0) await page.waitForTimeout(remain);
    const facts = await stable({ idle: true }); await shot('idle-' + second);
    report.idleSamples ??= []; report.idleSamples.push({ seconds: (performance.now() - start) / 1000, ...facts });
  }
  report.idleElapsedMs = performance.now() - start;
  check('At least 60 seconds of actual idle wall time', report.idleElapsedMs >= 60000);
  check('Actual repeated HTTP polling and backend heartbeats', counters.stateRequests - requestsAt >= 20 && heartbeatValues.size >= 10);
  check('Idle main DOM writes/root replacements zero; native textarea draft, focus, range and scroll stable');
  await page.evaluate(() => window.__stability.observer.disconnect());

  await page.locator('#prompt-input').fill('汇总演示养护待办并生成周报');
  const response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/tasks' && r.request().method() === 'POST');
  await page.locator('#task-form button[type="submit"]').click();
  const task = await (await response).json(); assert.ok(task.id); assert.equal(typeof task.status, 'string');
  await page.locator('.chat-thread').waitFor();
  await until(() => page.evaluate(() => !submitting && !pollBusy), 'composer settled after one submitted task');
  await draft(); await anchor(); await shot('task-running');
  const statuses = new Set([task.status]);
  await until(async () => {
    const s = await (await page.request.get(app.url + '/api/state')).json(), t = s.tasks.find(t => t.id === task.id);
    assert.ok(t); statuses.add(t.status); await stable();
    return t.status === 'completed';
  }, 'actual local demo engine completion');
  await page.locator('.task-result').waitFor(); await page.waitForTimeout(2250); await stable(); await shot('task-completed');
  check('One task submission only', counters.taskPosts === 1);
  check('Actual task completion updates preserve composer and mounted chat nodes', statuses.has('completed') && statuses.size >= 2);
  await page.evaluate(() => window.__stability.observer.disconnect());

  // A source-side owned fixture changes only this disposable completed task's
  // text. The actual HTTP API, renderer, CSS and native live Range remain real.
  const persisted = app.store.get('tasks', task.id); assert.ok(persisted && !persisted.localContext);
  const text = '原生输出选区稳定性测试：' + '仅合成资料，段落保持可读。'.repeat(25);
  app.store.put('tasks', task.id, { ...persisted, output: text });
  await page.locator('.task-result').filter({ hasText: text }).waitFor(); await draft(); await anchor();
  await page.evaluate(() => {
    const output = document.querySelector('.task-result'), walker = document.createTreeWalker(output, NodeFilter.SHOW_TEXT); let node;
    while ((node = walker.nextNode())) if (node.data.length > 20) break;
    if (!node) throw new Error('Output has no selectable text');
    const r = document.createRange(); r.setStart(node, 3); r.setEnd(node, 14); const s = document.getSelection(); s.removeAllRanges(); s.addRange(r);
    window.__stability.range = { node, start: 3, end: 14, text: s.toString() };
  });
  await shot('output-selected');
  app.store.put('tasks', task.id, { ...persisted, output: text + ' 新追加尾部仍须保持选中原文。' });
  await page.locator('.task-result').filter({ hasText: '新追加尾部' }).waitFor(); await stable({ focus: false, range: true });
  check('Native selected output Range survives a live same-paragraph suffix update');
  await post('/api/local-access/configure', { mode: 'confirm', roots: [docs], allFiles: false, onboardingComplete: true });
  await until(() => page.locator('#local-access-toggle').innerText().then(t => t.includes('请求批准')), 'permission update visible without navigation');
  await stable({ focus: false, range: true }); await shot('permission-confirm');
  await post('/api/local-access/revoke', {});
  await until(() => page.locator('#local-access-toggle').innerText().then(t => t.includes('关闭')), 'revoked permission visibly cleared');
  await stable({ focus: false, range: true }); await shot('permission-disabled');
  check('Real permission update and revoke remain visible while selected output and composer stay mounted');
  const detailsAt = counters.detailRequests; await page.waitForTimeout(6500); await stable({ focus: false, range: true });
  check('Settled selected task causes no repeated detail GETs', counters.detailRequests === detailsAt);
  assert.deepEqual(report.errors, []); check('No browser JavaScript errors');
  report.status = 'passed'; report.counters = counters; report.heartbeatsObserved = heartbeatValues.size; report.taskStatusesObserved = [...statuses];
} catch (error) {
  report.error = error.stack || String(error); console.error(report.error); process.exitCode = 1;
  if (page) await shot('failure').catch(() => {});
} finally {
  report.cleanupErrors = [];
  for (const [name, close] of [['context', () => context?.close()], ['browser', () => browser?.close()], ['server', () => app?.close()], ['owned temporary data', () => rm(owned, { recursive: true, force: true })]]) {
    try { await close(); } catch (error) { report.cleanupErrors.push(name + ': ' + String(error)); report.status = 'failed'; process.exitCode = 1; }
  }
  await writeFile(join(out, 'ui-stability-results.json'), JSON.stringify(report, null, 2) + '\n');
  console.log('UI stability evidence: ' + out);
}
