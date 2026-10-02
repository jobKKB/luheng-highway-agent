import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startServer } from '../server.mjs';
import { mailFixtures } from './mail-fixtures.mjs';
import { createControlledBrowserFixtures } from './fixtures/controlled-sites.mjs';

// Run in a normal desktop session. Uses its own temporary database, local port,
// and Chromium profile. It never touches the user's desktop app data.
const root = fileURLToPath(new URL('..', import.meta.url));
const outDir = resolve(root, 'artifacts/screenshots');
const dataDir = await mkdtemp(join(tmpdir(), 'luheng-ui-'));
const failures = [], stages = [], consoleErrors = [], httpFailures = [];
let app, browser, page, mailFixture, browserFixture;
const log = message => { stages.push(message); console.log('PASS ' + message); };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, description, timeout = 25000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const result = await fn(); if (result) return result; await wait(100); }
  throw new Error('Timed out: ' + description);
}
async function getState() {
  const response = await page.request.get(app.url + '/api/state');
  assert.equal(response.status(), 200);
  return response.json();
}
async function screenshot(name, fullPage = true) {
  await page.locator('#toast-root .toast').waitFor({state:'hidden',timeout:10000});
  const modalOpen = await page.locator('.modal').isVisible().catch(()=>false);
  await page.screenshot({path:join(outDir, name + '.png'), fullPage:fullPage&&!modalOpen, animations:'disabled'});
}
async function nav(name) {
  if(['schedules','agents','knowledge','mail','browser','audit'].includes(name)&&await page.locator('#nav-tools').isHidden())await page.locator('[data-action="toggle-tools"]').click();
  await page.locator('#nav [data-nav="' + name + '"]').click();
  await page.waitForURL('**/#' + name);
}
async function createPrompt(prompt) {
  await page.locator('.new-task-button').click();
  await page.locator('#prompt-input').fill(prompt);
  const response = page.waitForResponse(r => r.url().endsWith('/api/tasks') && r.request().method() === 'POST');
  await page.locator('#task-form button[type="submit"]').click();
  const task = await (await response).json();
  assert.ok(task.id);
  return task;
}
async function terminal(id, expected = 'completed') {
  const task = await until(async () => {const s = await getState(); const t = s.tasks.find(t=>t.id===id);return t && ['completed','failed','cancelled','rejected','needs_attention'].includes(t.status) && t;}, 'task terminal status');
  assert.equal(task.status, expected, task.error || task.output);
  return task;
}

try {
  await mkdir(outDir, {recursive:true});
  mailFixture = await mailFixtures();
  browserFixture = await createControlledBrowserFixtures();
  app = await startServer({port:0, dataDir, stepDelay:50,mailOptions:{allowTestLocal:true,testTls:{ca:mailFixture.cert},timeoutMs:5000},controlledBrowserOptions:{allowTestLocal:true}});
  browser = await chromium.launch({headless:true, chromiumSandbox:true, executablePath:process.env.HIGHWAY_CHROMIUM_PATH || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined)});
  const context = await browser.newContext({viewport:{width:1440,height:1000},locale:'zh-CN',acceptDownloads:true});
  page = await context.newPage();
  page.on('pageerror', error => consoleErrors.push(error.message));
  page.on('console', msg => {if(msg.type()==='error')consoleErrors.push(msg.text()+' ['+(msg.location().url||'page')+']');});
  page.on('response', async response=>{if(response.status()<400)return;const failed={method:response.request().method(),url:response.url(),status:response.status(),body:''};httpFailures.push(failed);try{failed.body=(await response.text()).slice(0,1500);}catch{}console.error('HTTP_FAILURE',JSON.stringify(failed));});
  await page.goto(app.url);
  await page.locator('#prompt-input').waitFor();
  assert.match(await page.locator('#mode-chip').innerText(), /任务演示模式/);
  assert.equal((await getState()).tasks.length, 0);
  await screenshot('home');
  log('Home loads with honest demo mode and empty task state');

  await nav('agents');
  assert.equal(await page.locator('.agent-card').count(), 3);
  await page.locator('[data-action="add-agent"]').first().click();
  await page.locator('#agent-name').fill('测试协作员（虚构）');
  await page.locator('#agent-role').fill('本地界面验收');
  await page.locator('#agent-personality').fill('仅处理虚构测试资料，注明来源。');
  await page.locator('#agent-form button[type="submit"]').click();
  await page.locator('#agent-form').waitFor({state:'hidden'});
  let s = await getState();
  const createdAgent = s.agents.find(a=>a.name==='测试协作员（虚构）');
  assert.deepEqual(createdAgent.permissions.sort(), ['knowledge.read','workspace.write']);
  await page.locator('[data-action="edit-agent"][data-id="'+createdAgent.id+'"]').click();
  await page.locator('#agent-personality').fill('修订后的虚构测试风格。');
  await page.locator('#agent-form [name="enabled"]').uncheck();
  await page.locator('#agent-form button[type="submit"]').click();
  await page.locator('#agent-form').waitFor({state:'hidden'});
  s = await getState();
  assert.equal(s.agents.find(a=>a.id===createdAgent.id).enabled, false);
  assert.match(s.agents.find(a=>a.id===createdAgent.id).personality, /修订/);
  await page.locator('[data-action="edit-agent"][data-id="'+createdAgent.id+'"]').click();
  await page.locator('#agent-inherit-model').uncheck();
  await page.locator('#agent-endpoint').fill('https://api.openai.com/v1');
  await page.locator('#agent-model').fill('ui-test-model-not-called');
  await page.locator('#agent-api-key').fill('FAKE_UI_ROLE_KEY_NOT_A_SECRET_2718');
  await page.locator('#agent-form button[type="submit"]').click();
  await page.locator('#agent-form').waitFor({state:'hidden'});
  s = await getState();
  assert.equal(s.agents.find(a=>a.id===createdAgent.id).modelConfig.inherit,false);
  assert.equal(s.agents.find(a=>a.id===createdAgent.id).hasApiKey,true);
  assert.ok(!JSON.stringify(s).includes('FAKE_UI_ROLE_KEY_NOT_A_SECRET_2718'));
  await page.locator('[data-action="edit-agent"][data-id="'+createdAgent.id+'"]').click();
  assert.equal(await page.locator('#agent-api-key').inputValue(),'');
  await page.locator('#agent-form [name="clearRoleApiKey"]').check();
  await screenshot('role-model');
  await page.locator('#agent-form button[type="submit"]').click();
  await page.locator('#agent-form').waitFor({state:'hidden'});
  assert.equal((await getState()).agents.find(a=>a.id===createdAgent.id).hasApiKey,false);
  log('Role-specific model configuration and memory-only key clearing work without calling model');
  // Editing the coordinator must not silently remove newer backend permissions.
  await page.locator('[data-action="edit-agent"][data-id="coordinator"]').click();
  assert.equal(await page.locator('#agent-form [name="permissions"]:checked').count(),9);
  await screenshot('agent-editor');
  await page.locator('#agent-form button[type="submit"]').click();
  await page.locator('#agent-form').waitFor({state:'hidden'});
  assert.equal((await getState()).agents.find(a=>a.id==='coordinator').permissions.length,9);
  await screenshot('agents');
  log('Agent create/edit/disable works and coordinator preserves all 9 permissions');

  await nav('knowledge');
  await page.locator('[data-action="add-memory"]').first().click();
  await page.locator('#memory-title').fill('UI 验证资料（虚构）');
  await page.locator('#memory-content').fill('本条知识仅用于 UI 自动化验收，不是真实公路数据。测试编号 QA-31415。');
  await page.locator('#memory-source').fill('本地 UI 自动化测试');
  await page.locator('#memory-form button[type="submit"]').click();
  await page.locator('#memory-form').waitFor({state:'hidden'});
  await page.getByText('UI 验证资料（虚构）',{exact:true}).waitFor();
  assert.ok((await getState()).memories.some(m=>m.content.includes('QA-31415')));
  await page.locator('[data-action="add-memory"]').first().click();
  await page.locator('#memory-scope').selectOption('agent');
  await page.locator('#memory-owner').selectOption('researcher');
  await page.locator('#memory-title').fill('研究员私有知识（虚构）');
  await page.locator('#memory-content').fill('PRIVATE-ROLE-QA-2718：仅用于验证角色检索隔离。');
  await page.locator('#memory-source').fill('本地角色隔离 UI 测试');
  await page.locator('#memory-form button[type="submit"]').click();
  await page.locator('#memory-form').waitFor({state:'hidden'});
  s = await getState();
  const privateNote = s.memories.find(m=>m.content.includes('PRIVATE-ROLE-QA-2718'));
  assert.equal(privateNote.scope,'agent');
  assert.equal(privateNote.ownerAgentId,'researcher');
  await page.getByText('角色私有 · 知行',{exact:true}).waitFor();
  log('Private knowledge form preserves explicit owner and displays context-isolation scope');
  await screenshot('knowledge');
  log('Knowledge form persists actual content and source');

  const report = await createPrompt('汇总演示养护待办并生成周报');
  const done = await terminal(report.id);
  assert.ok(done.artifact?.url);
  await page.locator('.file-download').waitFor();
  const downloaded = page.waitForEvent('download');
  await page.locator('.file-download').click();
  const download = await downloaded;
  const downloadPath = join(dataDir,'downloaded-report.txt');
  await download.saveAs(downloadPath);
  const reportContent = await readFile(downloadPath,'utf8');
  assert.match(reportContent,/虚构/);
  assert.match(reportContent,/QA-31415/);
  assert.ok(!reportContent.includes('PRIVATE-ROLE-QA-2718'),'cross-role report must not leak private notes');
  await screenshot('tasks');
  log('Report executes to completion, retrieves persisted knowledge, and downloads real artifact');

  const oa = await createPrompt('在模拟OA提交一条巡查安排');
  await until(async()=>{const s=await getState();const t=s.tasks.find(t=>t.id===oa.id);if(t?.status==='failed')throw new Error(t.error);return t?.status==='awaiting_approval';},'OA approval');
  await page.locator('[data-action="approve"]').waitFor();
  await screenshot('oa-approval');
  assert.equal((await getState()).tasks.find(t=>t.id===oa.id).browserSession.records.length,0);
  await page.locator('[data-action="browser-takeover"]').click();
  await page.locator('.oa-frame').waitFor();
  const fixture = page.frameLocator('.oa-frame');
  await fixture.locator('#title').fill('人工验证巡查安排（虚构）');
  await fixture.locator('#submit').click();
  await fixture.locator('#result').filter({hasText:'已保存'}).waitFor();
  await screenshot('oa-takeover');
  await page.locator('#modal-root [data-action="browser-resume"]').click();
  await page.locator('.oa-frame').waitFor({state:'hidden'});
  await page.locator('[data-action="approve"]').click();
  const oaDone = await terminal(oa.id);
  assert.equal(oaDone.browserSession.records.length,2);
  assert.equal(oaDone.browserSession.records[0].author,'manual');
  assert.equal(oaDone.browserSession.records[1].author,'agent-approved');
  log('OA shows approval first; iframe takeover and manual write work; resume and approval persist once');

  const mailTask = await createPrompt('起草一封养护协调邮件');
  await terminal(mailTask.id);
  s = await getState();
  assert.ok(s.mail.some(m=>m.taskId===mailTask.id));
  await page.locator('.browser-panel-toolbar').filter({hasText:'本地邮件草稿'}).waitFor();
  log('Mail workflow creates a visible local draft without sending');

  await nav('chat');
  if(await page.locator('#home-overview').isHidden())await page.locator('.overview-toggle').click();
  await page.locator('.suggestion-card[data-action="reminder"]').click();
  await page.locator('#reminder-title').fill('UI 自动化提醒（虚构）');
  await page.locator('#reminder-form button[type="submit"]').click();
  await page.locator('#reminder-form').waitFor({state:'hidden'});
  assert.ok((await getState()).reminders.some(r=>r.title==='UI 自动化提醒（虚构）'));
  const reminderTask = await createPrompt('请1秒后提醒我验证本地到期通知');
  await terminal(reminderTask.id);
  await until(async()=> (await getState()).notifications.some(n=>n.title==='验证本地到期通知'), 'actual due reminder');
  await page.locator('[data-action="notifications"]').click();
  await page.getByText('验证本地到期通知',{exact:true}).first().waitFor();
  await screenshot('reminders');
  await page.keyboard.press('Escape');
  await page.locator('.modal').waitFor({state:'hidden'});
  log('Reminder form persists and natural-language reminder fires into notifications');

  await nav('settings');
  await page.locator('#budget').fill('15');
  await page.locator('#settings-form button[type="submit"]').click();
  await until(async()=> (await getState()).settings.budget===15, 'saved budget');
  await page.locator('[data-action="test-api"]').click();
  await page.locator('#settings-status').filter({hasText:'没有连接真实大模型'}).waitFor();
  await screenshot('settings');
  assert.equal(await page.locator('#api-key').inputValue(),'');
  log('Settings save to backend; demo connection test makes no real model claim');

  await nav('mail');
  await page.getByText('尚未连接真实邮箱',{exact:true}).waitFor();
  assert.equal(await page.locator('[data-action="mail-fetch"]').isDisabled(),true);
  assert.equal(await page.locator('[data-action="mail-compose"]').first().isDisabled(),true);
  assert.equal((await getState()).mailOutbox.length,0);
  await screenshot('mail-unconfigured');
  await page.locator('[data-action="mail-config"]').first().click();
  await page.locator('#smtp-tls').selectOption('false');
  assert.equal(await page.locator('#smtp-port').inputValue(),'587');
  await page.locator('#imap-tls').selectOption('false');
  assert.equal(await page.locator('#imap-port').inputValue(),'143');
  await screenshot('mail-config');
  await page.keyboard.press('Escape');
  await page.locator('#mail-config-form').waitFor({state:'hidden'});
  log('Unconfigured real mail never fabricates inbox; controls disabled and TLS form reflects safe ports');

  // Configure and exercise actual authenticated local TLS transports. Every
  // address and password is fabricated; no real provider is contacted.
  await page.locator('[data-action="mail-config"]').first().click();
  await page.locator('#mail-account-id').fill(mailFixture.config.accountId);
  await page.locator('#mail-from').fill(mailFixture.config.from);
  for(const protocol of ['imap','smtp']){
    const config=mailFixture.config[protocol];
    await page.locator('#'+protocol+'-host').fill(config.host);
    await page.locator('#'+protocol+'-tls').selectOption('true');
    await page.locator('#'+protocol+'-port').fill(String(config.port));
    await page.locator('#'+protocol+'-user').fill(config.user);
    await page.locator('#'+protocol+'-password').fill(config.password);
  }
  await page.locator('#mail-config-form button[type="submit"]').click();
  await page.locator('#mail-config-form').waitFor({state:'hidden'});
  await until(async()=> (await getState()).mailAccounts.length===1,'configured TLS mailbox');
  s=await getState();
  assert.ok(s.mailAccounts[0].hasCredentials.imap&&s.mailAccounts[0].hasCredentials.smtp);
  assert.ok(!JSON.stringify(s).includes(mailFixture.config.imap.password));
  await page.locator('[data-action="mail-fetch"]').click();
  await page.getByText('Fixture 1',{exact:true}).waitFor();
  assert.equal((await getState()).realInbox.length,2);
  assert.ok(mailFixture.imap.authenticated>0);
  await screenshot('mail-inbox');
  await page.getByText('Fixture 1',{exact:true}).click();
  await page.locator('#modal-root .mail-received-body').filter({hasText:'Fabricated inbound message 1'}).waitFor();
  await page.keyboard.press('Escape');
  await page.locator('[data-action="mail-compose"]').first().click();
  await page.locator('#mail-to').fill('recipient@example.invalid');
  await page.locator('#mail-subject').fill('TLS UI 验证（虚构）');
  await page.locator('#mail-text').fill('本邮件只发送到本地 TLS 测试服务器，不是真实外部通信。');
  await page.locator('#mail-draft-form button[type="submit"]').click();
  await page.locator('#mail-draft-form').waitFor({state:'hidden'});
  assert.equal(mailFixture.smtp.dataCommands,0);
  await page.locator('[data-action="mail-edit"]').click();
  await page.locator('#mail-subject').fill('TLS UI 验证修订版（虚构）');
  await page.locator('#mail-draft-form button[type="submit"]').click();
  await page.locator('#mail-draft-form').waitFor({state:'hidden'});
  await page.locator('[data-action="mail-request-send"]').click();
  await page.locator('.mail-approval-snapshot').waitFor();
  assert.match(await page.locator('.mail-approval-snapshot').innerText(),/recipient@example.invalid/);
  assert.match(await page.locator('.mail-approval-snapshot').innerText(),/TLS UI 验证修订版/);
  assert.match(await page.locator('.mail-approval-snapshot').innerText(),new RegExp('127\\.0\\.0\\.1:'+mailFixture.config.smtp.port));
  assert.match(await page.locator('.mail-approval-snapshot').innerText(),/只发送到本地 TLS/);
  assert.equal(mailFixture.smtp.dataCommands,0,'review must not send');
  await screenshot('mail-approval');
  await page.locator('[data-action="mail-approve"]').click();
  await page.locator('.mail-approval-snapshot').waitFor({state:'hidden'});
  await until(async()=> (await getState()).mailOutbox.some(d=>d.status==='sent'),'SMTP accepted');
  assert.equal(mailFixture.smtp.messages.length,1);
  assert.ok(mailFixture.smtp.authenticated>0);
  assert.equal((await getState()).mailOutbox[0].attempts,1);
  await screenshot('mail-sent');
  log('Real-mail UI configures local TLS, reads IMAP, edits drafts, displays full snapshot and sends exactly once after approval');

  mailFixture.smtp.mode='drop-after-data';
  await page.locator('[data-action="mail-compose"]').first().click();
  await page.locator('#mail-to').fill('recipient@example.invalid');
  await page.locator('#mail-subject').fill('不确定状态验证（虚构）');
  await page.locator('#mail-text').fill('测试 DATA 已传输但服务器应答中断时，不提供重试。');
  await page.locator('#mail-draft-form button[type="submit"]').click();
  await page.locator('#mail-draft-form').waitFor({state:'hidden'});
  await page.locator('[data-action="mail-request-send"]').click();
  await page.locator('[data-action="mail-approve"]').click();
  await page.getByText('可能已经发送，请勿重试',{exact:true}).waitFor();
  const unknown=(await getState()).mailOutbox.find(d=>d.status==='unknown');
  assert.ok(unknown);
  assert.equal(unknown.attempts,1);
  assert.equal(await page.locator('.mail-draft-detail [data-action="mail-request-send"]').count(),0);
  assert.equal(await page.locator('.mail-draft-detail [data-action="mail-edit"]').count(),0);
  assert.equal(mailFixture.smtp.messages.length,2);
  await screenshot('mail-unknown');
  log('Delivery-unknown UI warns clearly and exposes no retry/edit button');

  mailFixture.smtp.mode='hold-after-data';
  await page.locator('[data-action="mail-compose"]').first().click();
  await page.locator('#mail-to').fill('recipient@example.invalid');
  await page.locator('#mail-subject').fill('传输中取消验证（虚构）');
  await page.locator('#mail-text').fill('测试 DATA 之后的取消仍然保留不确定状态，不能撤回。');
  await page.locator('#mail-draft-form button[type="submit"]').click();
  await page.locator('#mail-draft-form').waitFor({state:'hidden'});
  await page.locator('[data-action="mail-request-send"]').click();
  await page.locator('[data-action="mail-approve"]').click();
  await until(()=>mailFixture.smtp.messages.length===3,'third message body reached fixture');
  await page.keyboard.press('Escape');
  await page.locator('[data-action="mail-cancel"]').waitFor();
  assert.equal(await page.locator('[data-action="mail-cancel"]').isEnabled(),true);
  await page.locator('[data-action="mail-cancel"]').click();
  await until(async()=> (await getState()).mailOutbox.find(d=>d.subject==='传输中取消验证（虚构）')?.status==='unknown','cancel after DATA remains unknown');
  assert.equal(mailFixture.smtp.messages.length,3);
  await screenshot('mail-cancelled-unknown');
  log('In-flight mail cancellation stays available and retains unknown delivery after DATA');


  if(process.env.UI_SKIP_CONTROLLED!=='1'){
  await nav('browser');
  await page.getByText('尚未允许任何网站',{exact:true}).waitFor();
  await page.locator('[data-action="cb-add-target"]').click();
  await page.locator('#cb-target-id').fill('oa-ui-fixture');
  await page.locator('#cb-target-name').fill('虚构 OA 界面验收');
  await page.locator('#cb-start-url').fill(browserFixture.oa.origin+'/oa');
  const targetSaved = page.waitForResponse(r=>r.url().endsWith('/api/browser-targets')&&r.request().method()==='POST');
  await page.locator('#controlled-target-form button[type="submit"]').click();
  const targets=await (await targetSaved).json();
  assert.ok(targets.some(t=>t.id==='oa-ui-fixture'));
  await page.locator('#controlled-target-form').waitFor({state:'hidden'});
  assert.equal((await getState()).browserTargets.length,1);
  assert.equal(browserFixture.stats.inputs,0);
  await page.locator('[data-action="cb-open"]').click();
  await page.locator('#controlled-action-form').waitFor();
  await page.locator('[data-action="cb-read"]').click();
  await until(async()=> (await getState()).controlledSessions[0]?.lastObservation?.text.includes('会话：anonymous'),'fresh controlled observation');
  assert.equal(browserFixture.stats.unauthorizedWrites,0);
  assert.equal(browserFixture.stats.deniedHTTP,0);
  assert.equal(browserFixture.stats.deniedWS,0);
  assert.ok(!(await page.locator('#cb-control').innerText()).includes('账号密码'));
  await screenshot('controlled-browser');
  s=await getState();
  const controlled=s.controlledSessions[0];
  const field=controlled.lastObservation.controls.find(c=>c.label==='巡查安排');
  const save=controlled.lastObservation.controls.find(c=>c.label==='保存安排');
  await page.locator('#cb-control').selectOption(field.controlId);
  await page.locator('#cb-action-type').selectOption('fill');
  await page.locator('#cb-value').fill('虚构桥面巡查安排 UI-204');
  await page.locator('#controlled-action-form button[type="submit"]').click();
  await page.locator('#cb-control').selectOption(save.controlId);
  await page.locator('#cb-action-type').selectOption('click');
  await page.locator('#controlled-action-form button[type="submit"]').click();
  assert.equal(browserFixture.stats.inputs,0,'staged fill must not trigger input/autosave');
  assert.equal(browserFixture.stats.saves,0);
  await page.locator('[data-action="cb-propose"]').click();
  await page.locator('.controlled-exact-actions').waitFor();
  assert.match(await page.locator('.controlled-exact-actions').innerText(),/虚构桥面巡查安排 UI-204/);
  assert.match(await page.locator('.controlled-exact-actions').innerText(),/保存安排/);
  assert.equal(browserFixture.stats.inputs,0,'proposal must not trigger input/autosave');
  await screenshot('controlled-approval');
  await page.locator('[data-action="cb-approve"]').click();
  await page.locator('.controlled-exact-actions').waitFor({state:'hidden'});
  await until(()=>browserFixture.stats.saves===1,'approved controlled save');
  assert.equal(browserFixture.stats.inputs,1);
  assert.equal(browserFixture.stats.saves,1);
  await page.locator('[data-action="cb-takeover"]').click();
  await page.getByText('此窗口持有人工独占控制权。下面的单个操作由你直接发起，不经智能体审批；敏感字段仍然禁用。',{exact:true}).waitFor();
  s=await getState();
  const manualObs=s.controlledSessions[0].lastObservation;
  await page.locator('#cb-control').selectOption(manualObs.controls.find(c=>c.label==='巡查安排').controlId);
  await page.locator('#cb-action-type').selectOption('fill');
  await page.locator('#cb-value').fill('人工明确填写的虚构内容');
  await page.locator('#controlled-action-form button[type="submit"]').click();
  await until(()=>browserFixture.stats.inputs===2,'manual controlled fill');
  await screenshot('controlled-manual');
  await page.locator('[data-action="cb-resume"]').click();
  await until(async()=> (await getState()).controlledSessions[0].status==='agent','controlled resume');
  await page.locator('[data-action="cb-cancel"]').click();
  await until(async()=> (await getState()).controlledSessions[0].status==='cancelled','controlled close');
  assert.equal(browserFixture.stats.deniedHTTP,0);
  assert.equal(browserFixture.stats.receivedProxyCredentials,false);
  log('Controlled browser target/observe/approval/manual-lease/resume/close UI works; no input before approval and no off-origin requests');
  }

  await nav('audit');
  await page.getByText('创建任务',{exact:true}).first().waitFor();
  await screenshot('audit');
  log('Chinese audit view renders persisted operations');

  await page.setViewportSize({width:390,height:844});
  await page.goto(app.url+'/#chat');
  await page.locator('#prompt-input').waitFor();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false,'mobile horizontal overflow');
  await screenshot('mobile');
  await page.locator('[data-action="toggle-nav"]').click();
  await page.locator('#nav [data-nav="tasks"]').click();
  await page.locator('.task-detail').waitFor();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false,'mobile task horizontal overflow');
  await screenshot('mobile-tasks');
  await page.locator('[data-action="toggle-nav"]').click();
  await page.locator('[data-action="close-nav"]').click({position:{x:330,y:300}});
  assert.ok(!(await page.locator('body').getAttribute('class')||'').includes('nav-open'));
  log('390px mobile home/tasks fit without horizontal overflow; drawer opens and dismisses');
  await page.locator('[data-action="toggle-nav"]').click();
  await nav('mail');
  await page.locator('[data-mail-tab="outbox"]').click();
  await page.locator('.mail-draft-detail').waitFor();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false,'mobile mail horizontal overflow');
  await screenshot('mobile-mail');
  if(process.env.UI_SKIP_CONTROLLED!=='1'){
    await page.locator('[data-action="toggle-nav"]').click();
    await nav('browser');
    await page.locator('.controlled-detail').waitFor();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false,'mobile controlled browser horizontal overflow');
    await screenshot('mobile-browser');
  }
  log('Mobile mail and controlled-browser workspaces fit 390px layout');

  assert.deepEqual(consoleErrors,[],'No browser console/page errors');
  log('No browser console or page errors');
} catch (error) {
  failures.push(error.stack || error.message);
  console.error('FAIL',error.stack || error.message);
  if(page)try{await screenshot('failure');}catch{}
} finally {
  await browser?.close();
  await app?.close();
  await mailFixture?.close();
  await browserFixture?.close();
  await rm(dataDir,{recursive:true,force:true});
  await mkdir(outDir,{recursive:true});
  if(!failures.length)await rm(join(outDir,'failure.png'),{force:true});
  await writeFile(join(outDir,'ui-results.json'),JSON.stringify({ok:!failures.length,scope:process.env.UI_SKIP_CONTROLLED==='1'?'roles-mail-only':'full',at:new Date().toISOString(),stages,failures,consoleErrors,httpFailures},null,2));
}
if(failures.length)process.exitCode=1;
else console.log('UI_SMOKE_ALL_PASS · Screenshots: '+outDir);
