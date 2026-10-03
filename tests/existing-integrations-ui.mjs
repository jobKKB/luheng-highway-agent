import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startServer } from '../server.mjs';
import { mailContentHash } from '../lib/mail-adapter.mjs';
import { mailFixtures } from './mail-fixtures.mjs';
import { createControlledBrowserFixtures } from './fixtures/controlled-sites.mjs';

// Migrates the still-supported mail/controlled-browser paths from ui-smoke.mjs.
// Normal mode uses real CSS, sandboxed Chromium, TLS IMAP/SMTP and owned sites.
// --prepare-http deliberately NEVER launches a browser and cannot pass UI QA.
// No user data, real mailbox, external website, model provider or desktop vault.
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('..', import.meta.url));
const argv = process.argv.slice(2);
const prepareOnly = argv.includes('--prepare-http');
const outputIndex = argv.indexOf('--output-dir');
if (outputIndex >= 0) assert.ok(argv[outputIndex + 1], '--output-dir requires a path');
const out = resolve(outputIndex >= 0 ? argv[outputIndex + 1] : process.env.LUHENG_EXISTING_UI_QA_DIR || join(root, 'artifacts', 'screenshots', 'existing-integrations'));
const unknownArgs = argv.filter((value, index) => value !== '--prepare-http' && value !== '--output-dir' && !(outputIndex >= 0 && index === outputIndex + 1));
assert.deepEqual(unknownArgs, [], 'Unknown test arguments');
const checks = [], errors = [], pageErrors = [], screenshots = [], modelCalls = [];
const pass = (stage, label) => { checks.push({ stage, label }); console.log('PASS [' + stage + '] ' + label); };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, timeout = 25000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await fn(); if (value) return value; await delay(50); }
  throw new Error('Timed out: ' + label);
}
const sha256 = buffer => createHash('sha256').update(buffer).digest('hex');
async function sourceIdentity() {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const files = ['package.json', 'server.mjs', 'public/app.js', 'public/index.html', 'public/styles.css', 'public/ocean.css', 'public/chat.css', 'lib/mail-adapter.mjs', 'lib/controlled-browser.mjs', 'lib/engine.mjs', 'tests/mail-fixtures.mjs', 'tests/fixtures/controlled-sites.mjs', 'tests/existing-integrations-ui.mjs'];
  const inputs = [];
  for (const path of files) { const data = await readFile(join(root, path)); inputs.push({ path, bytes: data.length, sha256: sha256(data) }); }
  const deny = new Set(['node_modules', 'data', 'dist', 'bundle', 'bundle-win32-x64', '.runtime', '.git', '__pycache__', 'artifacts']);
  const top = new Set(['README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'package.json', 'package-lock.json', '.gitignore', 'server.mjs', 'SOURCE-MANIFEST.json']);
  const directories = new Set(['lib', 'public', 'tests', 'docs', 'scripts', 'desktop', '.github']);
  const tree = [];
  async function scan(relative = '') {
    for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
      if (deny.has(entry.name) || entry.isSymbolicLink() || entry.name.startsWith('.env')) continue;
      const path = relative ? relative + '/' + entry.name : entry.name;
      if (entry.isDirectory()) { if (relative || directories.has(entry.name)) await scan(path); }
      else if (entry.isFile() && (relative || top.has(entry.name)) && !/\.(sqlite|db|log|pyc)$/.test(entry.name)) { const data = await readFile(join(root, path)); tree.push({ path, bytes: data.length, sha256: sha256(data) }); }
    }
  }
  await scan(); tree.sort((one, two) => one.path < two.path ? -1 : one.path > two.path ? 1 : 0);
  return { version: pkg.version, sourceFileCount: tree.length, sourceTreeSha256: sha256(JSON.stringify(tree)), sourceFiles: tree, inputs, inputsSha256: sha256(JSON.stringify(inputs)), manifestSha256: existsSync(join(root, 'SOURCE-MANIFEST.json')) ? sha256(await readFile(join(root, 'SOURCE-MANIFEST.json'))) : null };
}
const recipients = ['recipient@example.invalid', 'second@example.invalid'];
const approvedText = '合成完整正文，仅由本地 TLS 夹具接收。\n第二行保留标点与换行。';
const taskMailPrompt = 'SYNTHETIC MAIL INTEGRATION TASK：请发送本地夹具邮件，完整内容先让我审批';
const taskBrowserPrompt = 'SYNTHETIC CONTROLLED INTEGRATION TASK：请填写并提交本地夹具网页，确切动作先让我审批';
const tool = (name, args, id) => ({ message: { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } });
// Explicit synthetic completion transport; this is injected into the actual
// engine, never an HTTP route pretending to be the UI or a real model service.
async function completion(request) {
  modelCalls.push({ user: request.messages.filter(message => message.role === 'user').at(-1)?.content, tools: request.messages.filter(message => message.role === 'tool').map(message => message.tool_call_id) });
  const prompt = request.messages.filter(message => message.role === 'user').at(-1)?.content || '';
  const results = request.messages.filter(message => message.role === 'tool');
  const result = id => { const message = results.find(message => message.tool_call_id === id); return message ? JSON.parse(message.content) : null; };
  if (prompt.includes('SYNTHETIC MAIL INTEGRATION TASK')) {
    if (!result('synthetic-mail-draft')) return tool('mail_create_draft', { accountId: 'fixture', to: recipients[0], subject: '任务完整审批（合成）', text: approvedText }, 'synthetic-mail-draft');
    assert.equal(result('synthetic-mail-draft').status, 'draft', 'Synthetic planner consumes only successful draft receipt');
    if (!result('synthetic-mail-send')) return tool('mail_request_send', { draftId: result('synthetic-mail-draft').id }, 'synthetic-mail-send');
    assert.equal(result('synthetic-mail-send').status, 'sent');
    return tool('agent_finish', { status: 'completed', summary: '本地合成 SMTP 已接受审批中的确切内容。', claimType: 'action', evidenceToolCallIds: ['synthetic-mail-send'] }, 'synthetic-mail-finish');
  }
  if (prompt.includes('SYNTHETIC CONTROLLED INTEGRATION TASK')) {
    if (!result('synthetic-browser-open')) return tool('browser_open_target', { targetId: 'oa-ui-fixture' }, 'synthetic-browser-open');
    if (!result('synthetic-browser-write')) {
      const opened = result('synthetic-browser-open'), obs = opened.observation;
      return tool('browser_propose_actions', { sessionId: opened.session.id, observationId: obs.observationId, reason: '仅本地合成任务验收', actions: [{ type: 'fill', controlId: obs.controls.find(control => control.label === '巡查安排').controlId, value: '任务已批准的合成网页内容' }, { type: 'click', controlId: obs.controls.find(control => control.label === '保存安排').controlId }] }, 'synthetic-browser-write');
    }
    assert.equal(result('synthetic-browser-write').status, 'completed');
    return tool('agent_finish', { status: 'completed', summary: '已核验本地合成网页批准动作。', claimType: 'action', evidenceToolCallIds: ['synthetic-browser-write'] }, 'synthetic-browser-finish');
  }
  throw new Error('Unexpected task sent to the synthetic integration provider');
}
async function harness() {
  const dir = await mkdtemp(join(tmpdir(), 'luheng-existing-integrations-'));
  let mail, sites, app;
  try {
    mail = await mailFixtures(); sites = await createControlledBrowserFixtures();
    app = await startServer({ port: 0, dataDir: dir, stepDelay: 1, completion, mailOptions: { allowTestLocal: true, testTls: { ca: mail.cert }, timeoutMs: 12000 }, controlledBrowserOptions: { allowTestLocal: true } });
    assert.equal(new URL(app.url).hostname, '127.0.0.1');
    const response = await fetch(app.url), cookie = response.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie, 'Actual loopback server must establish its normal session');
    async function api(path, body, method = body === undefined ? 'GET' : 'POST') {
      assert.ok(path.startsWith('/api/'), 'Only owned app endpoints are used');
      const response = await fetch(app.url + path, { method, headers: { cookie, origin: app.url, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, data: await response.json() };
    }
    return { dir, mail, sites, app, api, async close() { await app.close(); await mail.close(); await sites.close(); await rm(dir, { recursive: true, force: true }); } };
  } catch (error) { await app?.close(); await mail?.close(); await sites?.close(); await rm(dir, { recursive: true, force: true }); throw error; }
}
function assertSnapshot(approval, draft, h) {
  assert.equal(approval.type, 'mail.send'); assert.equal(approval.status, 'pending');
  assert.equal(approval.draftId, draft.id); assert.equal(approval.contentHash, mailContentHash(approval.snapshot));
  for (const key of ['accountId', 'from', 'to', 'subject', 'text', 'messageId', 'date', 'transportHash']) assert.deepEqual(approval.snapshot[key], draft[key], 'Exact snapshot field: ' + key);
  assert.deepEqual(approval.snapshot.transport, { host: '127.0.0.1', port: h.mail.config.smtp.port, secure: true, user: h.mail.config.smtp.user });
}
async function verifySourceContract() {
  const app = await readFile(join(root, 'public/app.js'), 'utf8');
  const server = await readFile(join(root, 'server.mjs'), 'utf8');
  for (const action of ['mail-config', 'mail-compose', 'mail-edit', 'mail-request-send', 'mail-review', 'mail-approve', 'mail-reject', 'mail-cancel', 'cb-add-target', 'cb-open', 'cb-read', 'cb-clear-actions', 'cb-propose', 'cb-review', 'cb-approve', 'cb-reject', 'cb-takeover', 'cb-resume', 'cb-cancel', 'open-mail-approval', 'open-controlled-approval']) assert.ok(app.includes('data-action="' + action + '"'), 'Existing visible action source: ' + action);
  for (const id of ['mail-config-form', 'mail-draft-form', 'controlled-target-form', 'controlled-action-form', 'cb-control', 'cb-action-type', 'cb-value']) assert.ok(app.includes('id="' + id + '"'), 'Existing form/control source: ' + id);
  for (const path of ['/api/browser-targets', '/api/controlled-browser/open', '/api/mail/config', '/api/mail/inbox', '/api/mail/drafts']) assert.ok(server.includes('path === "' + path + '"'), 'Exact server route source: ' + path);
  for (const route of [String.raw`/^\/api\/controlled-browser\/([^/]+)\/(propose|takeover|manual|resume|cancel)$/`, String.raw`/^\/api\/browser-approvals\/([^/]+)$/`, String.raw`/^\/api\/mail\/approvals\/([^/]+)$/`]) assert.ok(server.includes(route), 'Grouped service route source: ' + route);
  pass('source', 'Current visible forms/actions and exact live server routes exist; static contract only');
}
async function prepareHttp() {
  const h = await harness();
  try {
    let state = (await h.api('/api/state')).data;
    for (const field of ['mailAccounts', 'mailOutbox', 'mailApprovals', 'realInbox', 'browserTargets', 'controlledSessions', 'browserApprovals']) assert.deepEqual(state[field], [], field);
    assert.equal(state.settings.mode, 'api');
    assert.equal((await h.api('/api/mail/config', h.mail.config)).status, 200);
    assert.equal(h.mail.smtp.connections, 0); assert.equal(h.mail.imap.connections, 0);
    const inbox = await h.api('/api/mail/inbox', { accountId: 'fixture', limit: 50 });
    assert.equal(inbox.status, 200); assert.equal(inbox.data.messages.length, 2); assert.equal(inbox.data.messages[0].text.trim(), 'Fabricated inbound message 1');
    assert.equal((await h.api('/api/mail/inbox', { accountId: 'fixture', limit: 50 })).data.messages.length, 0);
    pass('http', 'Actual session, empty API-first state, TLS config and IMAP endpoint/shape');
    const create = patch => h.api('/api/mail/drafts', { accountId: 'fixture', to: recipients, subject: 'HTTP 合成审批', text: approvedText, ...patch });
    let draft = (await create()).data;
    let approval = (await h.api('/api/mail/drafts/' + draft.id + '/request-send', {})).data;
    assertSnapshot(approval, draft, h); assert.equal(h.mail.smtp.connections, 0);
    const edited = await h.api('/api/mail/drafts/' + draft.id, { subject: 'HTTP 合成审批修订', text: approvedText + '\n明确修订' }, 'PUT');
    assert.equal(edited.status, 200); draft = edited.data;
    state = (await h.api('/api/state')).data; assert.equal(state.mailApprovals.find(item => item.id === approval.id).status, 'invalidated');
    approval = (await h.api('/api/mail/drafts/' + draft.id + '/request-send', {})).data;
    assertSnapshot(approval, draft, h); assert.equal(h.mail.smtp.connections, 0);
    const sent = await h.api('/api/mail/approvals/' + approval.id, { decision: 'approve' });
    assert.equal(sent.status, 200); assert.equal(sent.data.status, 'sent'); assert.equal(sent.data.attempts, 1);
    const parsed = await require('mailparser').simpleParser(h.mail.smtp.messages[0].raw);
    assert.equal(parsed.subject, draft.subject); assert.equal(parsed.text.trim(), draft.text); assert.equal(parsed.messageId, draft.messageId); assert.deepEqual(parsed.to.value.map(item => item.address), recipients);
    assert.equal((await h.api('/api/mail/approvals/' + approval.id, { decision: 'approve' })).data.status, 'sent'); assert.equal(h.mail.smtp.messages.length, 1);
    pass('http', 'Create/edit/request/approve routes bind complete snapshot and SMTP emits exact MIME once');
    const count = h.mail.smtp.connections;
    draft = (await create({ subject: 'HTTP 拒绝' })).data; approval = (await h.api('/api/mail/drafts/' + draft.id + '/request-send', {})).data;
    assert.equal((await h.api('/api/mail/approvals/' + approval.id, { decision: 'reject' })).data.status, 'rejected');
    draft = (await create({ subject: 'HTTP 取消' })).data; approval = (await h.api('/api/mail/drafts/' + draft.id + '/request-send', {})).data;
    const cancelled = (await h.api('/api/mail/drafts/' + draft.id + '/cancel', {})).data;
    assert.equal(cancelled.status, 'failed'); assert.equal(cancelled.errorCode, 'MAIL_CANCELLED'); assert.equal(h.mail.smtp.connections, count);
    h.mail.smtp.mode = 'drop-after-data'; draft = (await create({ subject: 'HTTP unknown' })).data; approval = (await h.api('/api/mail/drafts/' + draft.id + '/request-send', {})).data;
    assert.equal((await h.api('/api/mail/approvals/' + approval.id, { decision: 'approve' })).data.status, 'unknown');
    assert.equal(h.mail.smtp.messages.length, 2);
    assert.equal((await h.api('/api/mail/approvals/' + approval.id, { decision: 'approve' })).data.status, 'unknown'); assert.equal(h.mail.smtp.messages.length, 2);
    pass('http', 'Reject/cancel connect no SMTP; actual DATA disconnect stays unknown without replay');
    // The controlled target configuration is positive preparation only: opening
    // a session/read/manual/resume requires the real Chromium stage below.
    const targets = await h.api('/api/browser-targets', { targets: [{ id: 'oa-ui-fixture', name: '虚构 OA UI 验收', startUrl: h.sites.oa.origin + '/oa' }] });
    assert.equal(targets.status, 200); assert.equal(targets.data[0].id, 'oa-ui-fixture'); assert.equal(targets.data[0].testOnly, true);
    state = (await h.api('/api/state')).data; assert.equal(state.browserTargets.length, 1); assert.deepEqual(state.controlledSessions, []); assert.equal(h.sites.stats.inputs, 0); assert.equal(h.sites.stats.saves, 0);
    assert.ok(!JSON.stringify(state).includes(h.mail.config.smtp.password));
    pass('http', 'Controlled target endpoint accepts owned fixture and does not open or input a page');
    await h.api('/api/settings', { mode: 'api', endpoint: 'https://8.8.8.8/v1', model: 'synthetic-existing-integrations', apiKey: 'SYNTHETIC-EXISTING-INTEGRATIONS-NOT-REAL', budget: 30 });
    h.mail.smtp.mode = 'normal';
    const taskResponse = await h.api('/api/tasks', { prompt: taskMailPrompt, budget: 30 }); assert.equal(taskResponse.status, 201);
    const task = await until(async () => { const value = (await h.api('/api/tasks/' + taskResponse.data.id)).data; if (value.status === 'failed') throw new Error(value.error); return value.status === 'awaiting_approval' ? value : null; }, 'synthetic mail task pauses');
    state = (await h.api('/api/state')).data;
    const taskApproval = state.mailApprovals.find(item => item.id === task.mailApprovalId), central = state.approvals.find(item => item.serviceApprovalId === taskApproval.id);
    assert.ok(central); assert.equal(h.mail.smtp.messages.length, 2); assert.equal(taskApproval.snapshot.text, approvedText);
    assert.equal((await h.api('/api/mail/approvals/' + taskApproval.id, { decision: 'approve' })).data.status, 'sent');
    const done = await until(async () => { const value = (await h.api('/api/tasks/' + task.id)).data; if (value.status === 'failed') throw new Error(value.error); return value.status === 'completed' ? value : null; }, 'synthetic mail task finishes from real receipt');
    assert.ok(done.toolEvidence.some(item => item.actionKinds.includes('mail_send'))); assert.equal(h.mail.smtp.messages.length, 3);
    pass('http', 'Explicit synthetic API engine links central mail approval and completes from actual SMTP receipt');
  } finally { await h.close(); }
}
async function runUi() {
  const h = await harness(); let browser, page;
  try {
    browser = await chromium.launch({ headless: true, chromiumSandbox: true, executablePath: process.env.HIGHWAY_CHROMIUM_PATH || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined) });
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', timezoneId: 'UTC', reducedMotion: 'reduce' });
    page.setDefaultTimeout(20000); page.on('pageerror', error => pageErrors.push(error.message));
    const state = async () => { const response = await page.request.get(h.app.url + '/api/state'); assert.equal(response.status(), 200); return response.json(); };
    async function shot(name) { await page.locator('#toast-root .toast').waitFor({ state: 'hidden', timeout: 15000 }); await page.screenshot({ path: join(out, name + '.png'), fullPage: !(await page.locator('.modal').isVisible().catch(() => false)), animations: 'disabled' }); screenshots.push(name + '.png'); }
    async function nav(name) {
      if (await page.locator('.mobile-menu').isVisible() && !((await page.locator('body').getAttribute('class')) || '').includes('nav-open')) await page.locator('.mobile-menu').click();
      if (['mail', 'browser'].includes(name) && await page.locator('#nav-tools').isHidden()) await page.locator('[data-action="toggle-tools"]').click();
      await page.locator('#nav [data-nav="' + name + '"]').click(); await page.waitForURL('**/#' + name);
    }
    async function compose(subject, text = approvedText) {
      await page.locator('[data-action="mail-compose"]').first().click();
      await page.locator('#mail-to').fill(recipients.join(', ')); await page.locator('#mail-subject').fill(subject); await page.locator('#mail-text').fill(text);
      await page.locator('#mail-draft-form [type="submit"]').click(); await page.locator('#mail-draft-form').waitFor({ state: 'hidden' });
      const draft = await until(async () => (await state()).mailOutbox.find(item => item.subject === subject), 'saved mail draft');
      await page.locator('.mail-draft-detail h2').filter({ hasText: subject }).waitFor(); return draft;
    }
    async function snapshot(subject, text, expectedRecipients = recipients) {
      const box = page.locator('.mail-approval-snapshot'); await box.waitFor(); const values = await box.locator('dd').allInnerTexts();
      assert.deepEqual(values, [h.mail.config.from, expectedRecipients.join(', '), '127.0.0.1:' + h.mail.config.smtp.port + ' · 隐式 TLS', h.mail.config.smtp.user, subject]);
      assert.equal(await box.locator('.output-block').innerText(), text);
      assert.equal(await page.locator('[data-action="mail-approve"]').isEnabled(), true);
    }
    async function stageFill(value) {
      const current = (await state()).controlledSessions.find(item => item.id === awaitId);
      const control = current.lastObservation.controls.find(item => item.label === '巡查安排'); assert.ok(control);
      await page.locator('#cb-control').selectOption(control.controlId); await page.locator('#cb-action-type').selectOption('fill'); await page.locator('#cb-value').fill(value);
      await page.locator('#controlled-action-form [type="submit"]').click();
    }
    async function stageSave() {
      const current = (await state()).controlledSessions.find(item => item.id === awaitId);
      await page.locator('#cb-control').selectOption(current.lastObservation.controls.find(item => item.label === '保存安排').controlId);
      await page.locator('#cb-action-type').selectOption('click'); await page.locator('#controlled-action-form [type="submit"]').click();
    }
    async function openControlled() {
      await page.locator('[data-action="cb-open"]').click();
      await page.waitForFunction(() => {
        const selected=state.controlledSessions.find(item=>item.id===selectedControlledId);
        const form=document.querySelector('#controlled-action-form');
        return selected?.status==='agent' && !controlledBusy.has('open') && form?.dataset.id===selected.id;
      });
      awaitId=await page.evaluate(()=>selectedControlledId);
    }
    async function newTask(prompt) {
      await page.locator('.new-task-button').click();
      await page.waitForFunction(() => view === 'chat' && !pollBusy && !submitting && document.activeElement === document.querySelector('#prompt-input'));
      await page.locator('#prompt-input').fill(prompt);
      const response = page.waitForResponse(response => response.url() === h.app.url + '/api/tasks' && response.request().method() === 'POST');
      await page.locator('.send-button').click(); const result = await (await response).json(); assert.ok(result.id); return result;
    }
    let awaitId;
    await page.goto(h.app.url); await page.locator('#local-access-form [data-action="local-defer"]').click(); await page.locator('.modal').waitFor({ state: 'hidden' }); await page.locator('#prompt-input').waitFor();
    await nav('settings'); await page.locator('#endpoint').fill('https://8.8.8.8/v1'); await page.locator('#model').fill('synthetic-existing-integrations'); await page.locator('#api-key').fill('SYNTHETIC-EXISTING-INTEGRATIONS-NOT-REAL'); await page.locator('#budget').fill('30');
    await page.locator('#settings-form [type="submit"]').click(); await page.waitForFunction(() => state.settings.hasApiKey && !settingsSaving);
    await nav('mail'); assert.equal(await page.locator('[data-action="mail-fetch"]').isDisabled(), true); assert.equal(await page.locator('[data-action="mail-compose"]').first().isDisabled(), true); assert.equal((await state()).mailOutbox.length, 0);
    await page.locator('[data-action="mail-config"]').first().click(); await page.locator('#smtp-tls').selectOption('false'); assert.equal(await page.locator('#smtp-port').inputValue(), '587'); await page.locator('#imap-tls').selectOption('false'); assert.equal(await page.locator('#imap-port').inputValue(), '143'); await page.keyboard.press('Escape'); await page.locator('.modal').waitFor({ state: 'hidden' });
    await page.locator('[data-action="mail-config"]').first().click(); await page.locator('#mail-account-id').fill('fixture'); await page.locator('#mail-from').fill(h.mail.config.from);
    for (const protocol of ['imap', 'smtp']) { const config = h.mail.config[protocol]; await page.locator('#' + protocol + '-host').fill(config.host); await page.locator('#' + protocol + '-tls').selectOption('true'); await page.locator('#' + protocol + '-port').fill(String(config.port)); await page.locator('#' + protocol + '-user').fill(config.user); await page.locator('#' + protocol + '-password').fill(config.password); }
    await page.locator('#mail-config-form [type="submit"]').click(); await page.locator('.modal').waitFor({ state: 'hidden' }); assert.equal(h.mail.smtp.connections, 0); assert.equal(h.mail.imap.connections, 0);
    await page.locator('[data-action="mail-fetch"]').click(); await page.getByText('Fixture 1', { exact: true }).waitFor(); assert.equal((await state()).realInbox.length, 2); assert.ok(h.mail.imap.authenticated > 0);
    await page.getByText('Fixture 1', { exact: true }).click(); await page.locator('.mail-received-body').filter({ hasText: 'Fabricated inbound message 1' }).waitFor(); await page.keyboard.press('Escape');
    pass('ui', 'Unconfigured mail, TLS form/Escape, actual TLS account and IMAP detail');
    const editedDraft = await compose('待修订完整审批（合成）'); await page.locator('[data-action="mail-request-send"]').click(); await snapshot(editedDraft.subject, approvedText); assert.equal(h.mail.smtp.connections, 0);
    const originalApproval = (await state()).mailApprovals.find(item => item.draftId === editedDraft.id && item.status === 'pending');
    await page.keyboard.press('Escape'); await page.locator('[data-action="mail-edit"]').click(); await page.locator('#mail-subject').fill('已修订完整审批（合成）'); const revisedText = approvedText + '\n审批前明确编辑'; await page.locator('#mail-text').fill(revisedText); await page.waitForTimeout(2200); assert.equal(await page.locator('#mail-text').inputValue(), revisedText);
    await page.locator('#mail-draft-form [type="submit"]').click(); await page.locator('.modal').waitFor({ state: 'hidden' }); assert.equal((await state()).mailApprovals.find(item => item.id === originalApproval.id).status, 'invalidated');
    await page.locator('[data-action="mail-request-send"]').click(); await snapshot('已修订完整审批（合成）', revisedText); assert.equal(h.mail.smtp.connections, 0); await shot('mail-full-approval');
    await page.locator('[data-action="mail-approve"]').click(); await page.locator('.modal').waitFor({ state: 'hidden' }); await until(async () => (await state()).mailOutbox.find(item => item.id === editedDraft.id)?.status === 'sent', 'approved mail sends');
    assert.equal(h.mail.smtp.messages.length, 1); const parsed = await require('mailparser').simpleParser(h.mail.smtp.messages[0].raw); assert.equal(parsed.text.trim(), revisedText); assert.equal(parsed.subject, '已修订完整审批（合成）'); assert.deepEqual(parsed.to.value.map(item => item.address), recipients); assert.equal(parsed.messageId, editedDraft.messageId);
    await page.reload(); await page.locator('[data-mail-tab="outbox"]').click(); await page.locator('.mail-draft-detail').waitFor(); assert.equal(h.mail.smtp.messages.length, 1); assert.equal((await state()).mailOutbox.find(item => item.id === editedDraft.id).attempts, 1);
    pass('ui', 'Full snapshot, edit invalidation/polling preservation, exact approved MIME and reload send-once');
    const smtpConnections = h.mail.smtp.connections;
    const rejected = await compose('明确拒绝（合成）'); await page.locator('[data-action="mail-request-send"]').click(); await page.locator('[data-action="mail-reject"]').click(); await page.locator('.modal').waitFor({ state: 'hidden' }); assert.equal((await state()).mailOutbox.find(item => item.id === rejected.id).status, 'rejected');
    const cancelled = await compose('发送前取消（合成）'); await page.locator('[data-action="mail-request-send"]').click(); await page.locator('.mail-approval-snapshot').waitFor(); await page.keyboard.press('Escape'); await page.locator('[data-action="mail-cancel"]').click(); await until(async () => (await state()).mailOutbox.find(item => item.id === cancelled.id)?.errorCode === 'MAIL_CANCELLED', 'cancel pending draft'); assert.equal(h.mail.smtp.connections, smtpConnections); assert.equal(h.mail.smtp.messages.length, 1);
    pass('ui', 'Reject and pending-send cancel buttons send no SMTP');
    h.mail.smtp.mode = 'drop-after-data'; const unknown = await compose('投递未知（合成）'); await page.locator('[data-action="mail-request-send"]').click(); await page.locator('[data-action="mail-approve"]').click(); await page.getByText('可能已经发送，请勿重试', { exact: true }).waitFor();
    assert.equal((await state()).mailOutbox.find(item => item.id === unknown.id).status, 'unknown'); assert.equal(await page.locator('.mail-draft-detail [data-action="mail-request-send"]').count(), 0); assert.equal(await page.locator('.mail-draft-detail [data-action="mail-edit"]').count(), 0); await shot('mail-unknown');
    await page.reload(); await page.locator('[data-mail-tab="outbox"]').click(); await page.getByText('可能已经发送，请勿重试', { exact: true }).waitFor(); await page.waitForTimeout(2200); assert.equal(h.mail.smtp.messages.length, 2); assert.equal((await state()).mailOutbox.find(item => item.id === unknown.id).attempts, 1);
    h.mail.smtp.mode = 'hold-after-data'; const inFlight = await compose('DATA 后取消（合成）'); await page.locator('[data-action="mail-request-send"]').click(); await page.locator('[data-action="mail-approve"]').click(); await until(() => h.mail.smtp.messages.length === 3, 'body reaches held TLS fixture'); await page.keyboard.press('Escape'); await page.locator('[data-action="mail-cancel"]').click(); await until(async () => (await state()).mailOutbox.find(item => item.id === inFlight.id)?.status === 'unknown', 'DATA cancel is unknown'); assert.equal(h.mail.smtp.messages.length, 3); h.mail.smtp.mode = 'normal';
    pass('ui', 'Actual DATA disconnect/reload and in-flight cancel retain unknown without resend/edit');
    await nav('browser'); await page.locator('[data-action="cb-add-target"]').click(); await page.locator('#cb-target-id').fill('oa-ui-fixture'); await page.locator('#cb-target-name').fill('虚构 OA UI 验收'); await page.locator('#cb-start-url').fill(h.sites.oa.origin + '/oa'); await page.locator('#controlled-target-form [type="submit"]').click(); await page.locator('.modal').waitFor({ state: 'hidden' });
    assert.equal((await state()).browserTargets.length, 1); assert.equal(h.sites.stats.inputs, 0); await openControlled(); await page.locator('[data-action="cb-read"]').click();
    await page.getByText('已重新读取页面，旧的待提交动作已清空',{exact:true}).waitFor();
    await page.waitForFunction(()=>!controlledBusy.has(selectedControlledId));
    const opened = await until(async () => (await state()).controlledSessions.find(item => item.lastObservation?.text.includes('会话：anonymous')), 'fresh controlled observation'); awaitId = opened.id; assert.ok(!(await page.locator('#cb-control').innerText()).includes('账号密码'));
    await stageFill('尚未批准的合成内容'); await page.locator('.controlled-action-row').waitFor(); await page.waitForTimeout(2200); assert.match(await page.locator('.controlled-staged').innerText(), /尚未批准的合成内容/); assert.equal(h.sites.stats.inputs, 0); await page.locator('[data-action="cb-clear-actions"]').click(); assert.equal(await page.locator('.controlled-action-row').count(), 0);
    await stageFill('拒绝的合成内容'); await stageSave(); assert.equal(h.sites.stats.inputs, 0); assert.equal(h.sites.stats.saves, 0); await page.locator('[data-action="cb-propose"]').click(); await page.locator('.controlled-exact-actions').waitFor(); assert.equal(h.sites.stats.inputs, 0); await page.locator('[data-action="cb-reject"]').click(); await page.locator('.modal').waitFor({ state: 'hidden' }); assert.equal(h.sites.stats.saves, 0); assert.equal(h.sites.stats.inputs, 0);
    await stageFill('已批准的合成网页内容'); await stageSave(); await page.locator('[data-action="cb-propose"]').click(); await page.locator('.controlled-exact-actions').waitFor();
    assert.equal(await page.locator('.controlled-exact-actions li').count(), 2); assert.equal(await page.locator('.controlled-exact-actions pre').innerText(), '已批准的合成网页内容'); assert.match(await page.locator('.controlled-exact-actions li').last().innerText(), /保存安排/); assert.equal(await page.locator('.mail-approval-snapshot dd').first().innerText(), h.sites.oa.origin + '/oa'); assert.equal(h.sites.stats.inputs, 0); assert.equal(h.sites.stats.saves, 0); await shot('controlled-full-approval');
    await page.keyboard.press('Escape'); await page.locator('[data-action="cb-review"]').click(); await page.locator('[data-action="cb-approve"]').click(); await page.locator('.modal').waitFor({ state: 'hidden' }); await until(() => h.sites.stats.saves === 1 && h.sites.stats.inputs === 1, 'only approved batch causes autosave/save');
    await page.locator('[data-action="cb-read"]').click(); await until(async () => (await state()).controlledSessions.find(item => item.id === awaitId)?.lastObservation.text.includes('已保存 1：已批准的合成网页内容'), 'approved save observed');
    pass('ui', 'Owned target/open/read, clear/reject/stage/propose/review, exact approval and no preapproval autosave');
    await page.locator('[data-action="cb-takeover"]').click(); await page.getByText('此窗口持有人工独占控制权。下面的单个操作由你直接发起，不经智能体审批；敏感字段仍然禁用。', { exact: true }).waitFor();
    await stageFill('人工明确填写的合成内容'); await until(() => h.sites.stats.inputs === 2, 'manual lease fill'); assert.equal(await page.locator('[data-action="cb-propose"]').count(), 0); await stageSave(); await until(() => h.sites.stats.saves === 2, 'manual lease save'); await shot('controlled-manual');
    await page.locator('[data-action="cb-resume"]').click(); await until(async () => (await state()).controlledSessions.find(item => item.id === awaitId)?.status === 'agent', 'resume lease'); assert.match((await state()).controlledSessions.find(item => item.id === awaitId).lastObservation.text, /已保存 2：人工明确填写的合成内容/);
    await stageFill('关闭前未批准的内容'); await page.locator('[data-action="cb-propose"]').click(); await page.locator('.controlled-exact-actions').waitFor(); await page.keyboard.press('Escape'); await page.locator('[data-action="cb-cancel"]').click(); await until(async () => (await state()).controlledSessions.find(item => item.id === awaitId)?.status === 'cancelled', 'close session'); assert.equal(h.sites.stats.inputs, 2); assert.equal(h.sites.stats.saves, 2);
    assert.equal(await page.locator('[data-action="cb-takeover"]').count(), 0); assert.equal(await page.locator('#controlled-action-form [type="submit"]').isDisabled(), true);
    pass('ui', 'Actual manual lease fill/save, resume/reobservation and close with pending batch cause no replay');
    // Reload discards the in-window lease; the server still owns the manual
    // session. UI must neither resume nor silently regain manual authorization.
    await openControlled(); await page.locator('[data-action="cb-takeover"]').click(); await page.locator('[data-action="cb-resume"]').waitFor(); const reloadedLease = (await state()).controlledSessions.find(item => item.status === 'manual').id;
    await page.reload(); await page.locator('.controlled-detail').waitFor(); await page.getByText('此窗口没有当前人工租约，可能已刷新页面或由其他窗口接管。不能操作或归还；可关闭此会话后重新建立。', { exact: true }).waitFor(); assert.equal(await page.locator('[data-action="cb-resume"]').isDisabled(), true); assert.equal(await page.locator('#controlled-action-form [type="submit"]').isDisabled(), true); assert.equal((await state()).controlledSessions.find(item => item.id === reloadedLease).status, 'manual'); await page.locator('[data-action="cb-cancel"]').click(); await until(async () => (await state()).controlledSessions.find(item => item.id === reloadedLease)?.status === 'cancelled', 'lease reload close');
    pass('ui', 'Reload loses manual lease and disables manual/resume until explicit close');
    await nav('chat'); const mailTask = await newTask(taskMailPrompt); await page.locator('[data-action="open-mail-approval"]').waitFor(); assert.equal(h.mail.smtp.messages.length, 3); assert.equal(await page.locator('.chat-turn [data-action="approve"]').count(), 0); await page.locator('[data-action="open-mail-approval"]').click(); await snapshot('任务完整审批（合成）', approvedText, [recipients[0]]); await page.locator('[data-action="mail-approve"]').click(); await page.locator('.modal').waitFor({ state: 'hidden' }); await until(async () => (await state()).tasks.find(item => item.id === mailTask.id)?.status === 'completed', 'central mail task finishes'); assert.equal(h.mail.smtp.messages.length, 4);
    await nav('chat'); const browserTask = await newTask(taskBrowserPrompt); await page.locator('[data-action="open-controlled-approval"]').waitFor(); assert.equal(h.sites.stats.inputs, 2); assert.equal(h.sites.stats.saves, 2); assert.equal(await page.locator('.chat-turn [data-action="approve"]').count(), 0); await page.locator('[data-action="open-controlled-approval"]').click(); await page.locator('.controlled-exact-actions').waitFor(); assert.equal(await page.locator('.controlled-exact-actions pre').innerText(), '任务已批准的合成网页内容'); await page.locator('[data-action="cb-approve"]').click(); await page.locator('.modal').waitFor({ state: 'hidden' }); await until(async () => (await state()).tasks.find(item => item.id === browserTask.id)?.status === 'completed', 'central controlled task finishes'); assert.equal(h.sites.stats.inputs, 3); assert.equal(h.sites.stats.saves, 3); await page.locator('[data-action="cb-cancel"]').click();
    pass('ui', 'API-first conversation central mail/browser actions open full workspace approvals then resume from real receipts');
    // Layout assertions use the live CSS and native interaction paths at 360px.
    await page.setViewportSize({ width: 360, height: 780 }); await nav('mail'); await page.locator('[data-mail-tab="outbox"]').click(); await page.locator('.mail-draft-detail').waitFor(); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false); await shot('mobile-mail'); const mobileMail = await compose('移动端完整审批（合成）'); await page.locator('[data-action="mail-request-send"]').click(); await snapshot(mobileMail.subject, approvedText); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false); await shot('mobile-mail-approval'); await page.locator('[data-action="mail-reject"]').click(); await page.locator('.modal').waitFor({ state: 'hidden' }); assert.equal(h.mail.smtp.messages.length, 4); await nav('browser'); await page.locator('.controlled-detail').waitFor(); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false); await shot('mobile-controlled'); await openControlled(); awaitId = (await state()).controlledSessions.find(item => item.status === 'agent').id; await stageFill('移动端审批仅合成文本'); await page.locator('[data-action="cb-propose"]').click(); await page.locator('.controlled-exact-actions').waitFor(); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false); await shot('mobile-controlled-approval'); await page.locator('[data-action="cb-reject"]').click(); await page.locator('.modal').waitFor({ state: 'hidden' }); await page.locator('[data-action="cb-cancel"]').click(); await until(async () => (await state()).controlledSessions.find(item => item.id === awaitId)?.status === 'cancelled', 'mobile close'); assert.equal(h.sites.stats.inputs, 3); assert.equal(h.sites.stats.saves, 3);
    assert.equal(h.sites.stats.unauthorizedWrites, 0); assert.equal(h.sites.stats.deniedHTTP, 0); assert.equal(h.sites.stats.deniedWS, 0); assert.deepEqual(pageErrors, []); assert.ok(!JSON.stringify(await state()).includes(h.mail.config.smtp.password));
    pass('ui', '360px mail/browser real layout, no page errors or fixture side effects outside approvals/manual actions');
  } catch (error) { if (page) { try { await page.screenshot({ path: join(out, 'failure.png'), animations: 'disabled' }); screenshots.push('failure.png'); } catch {} } throw error; }
  finally { await browser?.close(); await h.close(); }
}
await mkdir(out, { recursive: true });
const source = await sourceIdentity();
let httpPassed = false, browserPassed = false;
try { await verifySourceContract(); await prepareHttp(); httpPassed = true; if (!prepareOnly) { await runUi(); browserPassed = true; } }
catch (error) { errors.push(error.stack || error.message); console.error('FAIL', error.stack || error.message); process.exitCode = 1; }
finally {
  const report = { mode: prepareOnly ? 'http-preparation-only' : 'real-chromium-ui', version: source.version, source, httpPreparationPassed: httpPassed, browserAttempted: !prepareOnly && httpPassed, browserPassed, completeUiPassed: !prepareOnly && browserPassed && !errors.length, checks, screenshots, pageErrors, errors, syntheticModelCalls: modelCalls, scope: 'Owned temporary databases and profiles; fabricated TLS mailbox and controlled-site fixtures; explicitly injected synthetic API completion; no real accounts/providers; Chromium sandbox unchanged', notCovered: prepareOnly ? ['All real-browser interaction, CSS/layout, controlled open/observe/action/lease paths and screenshots; Windows CI must execute normal mode'] : ['Real external mail providers/websites, physical desktop/IME and installer upgrade are separate acceptance stages'], at: new Date().toISOString() };
  await writeFile(join(out, 'existing-integrations-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ mode: report.mode, httpPreparationPassed: httpPassed, completeUiPassed: report.completeUiPassed, report: join(out, 'existing-integrations-report.json'), version: source.version, sourceInputsSha256: source.inputsSha256 }, null, 2));
}
