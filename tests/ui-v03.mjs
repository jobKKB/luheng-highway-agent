import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../server.mjs';

// Functional UI coverage only. The desktop bridge is a fake; this does not
// validate OS encryption, the tray integration, or browser security boundaries.
const dataDir = await mkdtemp(join(tmpdir(), 'luheng-v03-ui-'));
const screenshots = resolve('artifacts/screenshots-v03');
let app, standalone, browser, page;
let savedSnapshot = null, saveCalls = 0, forgetCalls = 0;
const desktop = { backgroundEnabled: false, trayAvailable: true };
const vault = { available: true, stored: false, backend: 'TEST-ONLY fake secure storage', reason: '' };
const desktopBridge = {
  preferences: async () => ({...desktop}),
  status: async () => ({...vault}),
  setPreferences: async value => { desktop.backgroundEnabled = value.backgroundEnabled; },
  saveCredentials: async value => { saveCalls++; savedSnapshot = structuredClone(value); vault.stored = true; },
  forgetCredentials: async () => { forgetCalls++; savedSnapshot = null; vault.stored = false; },
};
const errors = [];
const nav = async name => { if(['schedules','agents','knowledge','mail','browser','audit'].includes(name)&&await page.locator('#nav-tools').isHidden())await page.locator('[data-action="toggle-tools"]').click(); await page.locator('#nav [data-nav="'+name+'"]').click(); await page.waitForURL('**/#'+name); };
const getState = async () => (await page.request.get(app.url+'/api/state')).json();
const settle = async (check, label, timeout=20000) => { const end=Date.now()+timeout; while(Date.now()<end){const value=await check();if(value)return value;await new Promise(r=>setTimeout(r,80));}throw new Error('Timed out: '+label); };
const shot = async name => {
  await page.locator('#toast-root .toast').waitFor({state:'hidden',timeout:10000});
  const modalOpen=await page.locator('.modal').count()>0;
  if(!modalOpen){
    await page.evaluate(()=>window.scrollTo({top:0,behavior:'instant'}));
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  }
  // The desktop state in this suite is explicitly a fake integration fixture.
  await page.screenshot({path:join(screenshots,name+'.png'),fullPage:!modalOpen,animations:'disabled'});
};
const log = text => console.log('PASS '+text);
try {
  await mkdir(screenshots,{recursive:true});
  app = await startServer({port:0,dataDir:join(dataDir,'desktop'),stepDelay:20,desktopBridge});
  browser = await chromium.launch({headless:true,chromiumSandbox:true,executablePath:process.env.HIGHWAY_CHROMIUM_PATH||(existsSync('/usr/bin/chromium')?'/usr/bin/chromium':undefined)});
  page = await browser.newPage({viewport:{width:1440,height:1000},locale:'zh-CN',timezoneId:'Asia/Shanghai',acceptDownloads:true});
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto(app.url);
  await page.locator('#prompt-input').waitFor();
  await nav('schedules');
  assert.match(await page.locator('#main').innerText(),/错过的多次执行合并为最多一次/);
  await page.locator('[data-action="add-schedule"]').first().click();
  assert.equal(await page.locator('#schedule-timezone').inputValue(),'Asia/Shanghai');
  await page.locator('#schedule-title').fill('UI 周报计划（虚构）');
  await page.locator('#schedule-prompt').fill('汇总演示养护待办并生成周报');
  await page.locator('#schedule-timezone').fill('Bad/Timezone');
  await page.locator('#schedule-form [type="submit"]').click();
  await page.locator('.modal-error').filter({hasText:'IANA'}).waitFor();
  assert.equal((await getState()).schedules.length,0);
  await page.locator('#schedule-timezone').fill('Asia/Shanghai');
  await page.locator('#schedule-recurrence').selectOption('weekly');
  await page.locator('#schedule-days-field input:checked').uncheck();
  await page.locator('#schedule-form [type="submit"]').click();
  await page.locator('.modal-error').filter({hasText:'至少选择一天'}).waitFor();
  await page.locator('#schedule-days-field input[value="1"]').check();
  await page.locator('#schedule-days-field input[value="5"]').check();
  await page.locator('#schedule-time').fill('09:30');
  await shot('schedule-editor');
  await page.locator('#schedule-form [type="submit"]').click();
  await page.locator('#schedule-form').waitFor({state:'hidden'});
  let state=await getState(), schedule=state.schedules[0];
  assert.equal(schedule.status,'active');
  assert.equal(schedule.timezone,'Asia/Shanghai');
  assert.deepEqual(schedule.recurrence,{type:'weekly',time:'09:30',daysOfWeek:[1,5]});
  assert.equal(schedule.agentId,'coordinator');
  const card=()=>page.locator('[data-schedule-id="'+schedule.id+'"]');
  assert.match(await card().innerText(),/每周一、五 09:30/);
  await card().locator('[data-action="edit-schedule"]').click();
  await page.locator('#schedule-title').fill('轮询不能覆盖正在编辑的计划');
  await page.waitForTimeout(2200);
  assert.equal(await page.locator('#schedule-title').inputValue(),'轮询不能覆盖正在编辑的计划');
  await page.keyboard.press('Escape');
  assert.equal((await getState()).schedules[0].title,'UI 周报计划（虚构）');
  await card().locator('[data-action="edit-schedule"]').click();
  await page.locator('#schedule-title').fill('UI 间隔计划（虚构）');
  await page.locator('#schedule-recurrence').selectOption('interval');
  assert.equal(await page.locator('#schedule-time').isDisabled(),true);
  await page.locator('#schedule-interval').fill('525600');
  await page.locator('#schedule-agent').selectOption('researcher');
  await page.locator('#schedule-form [type="submit"]').click();
  await page.locator('#schedule-form').waitFor({state:'hidden'});
  schedule=(await getState()).schedules[0];
  assert.equal(schedule.recurrence.intervalMinutes,525600);
  assert.equal(schedule.agentId,'researcher');
  await card().locator('[data-action="edit-schedule"]').click();
  await page.locator('#schedule-agent').selectOption('');
  await page.locator('#schedule-form [type="submit"]').click();
  await page.locator('#schedule-form').waitFor({state:'hidden'});
  assert.equal((await getState()).schedules[0].agentId,'coordinator');
  await card().locator('[data-action="schedule-pause"]').click();
  await card().locator('[data-action="schedule-resume"]').waitFor();
  assert.equal((await getState()).schedules[0].status,'paused');
  await card().locator('[data-action="schedule-resume"]').click();
  await card().locator('[data-action="schedule-pause"]').waitFor();
  assert.equal((await getState()).schedules[0].status,'active');
  await card().locator('[data-action="cancel-schedule"]').click();
  await page.locator('#modal-root [data-action="close-modal"]').last().click();
  assert.equal((await getState()).schedules[0].status,'active');
  await card().locator('[data-action="cancel-schedule"]').click();
  await page.locator('[data-action="schedule-cancel"]').click();
  await page.locator('.modal').waitFor({state:'hidden'});
  assert.equal((await getState()).schedules[0].status,'cancelled');
  assert.equal(await card().locator('[data-action="edit-schedule"]').count(),0);
  await page.locator('[data-action="add-schedule"]').first().click();
  await page.locator('#schedule-title').fill('UI 每日计划（虚构）');
  await page.locator('#schedule-prompt').fill('整理本地资料');
  await page.locator('#schedule-timezone').fill('America/New_York');
  await page.locator('#schedule-time').fill('13:45');
  await page.locator('#schedule-form [type="submit"]').click();
  await page.locator('#schedule-form').waitFor({state:'hidden'});
  const daily=(await getState()).schedules.find(s=>s.title==='UI 每日计划（虚构）');
  assert.deepEqual(daily.recurrence,{type:'daily',time:'13:45'});
  assert.equal(daily.timezone,'America/New_York');
  await shot('schedules');
  log('Schedule forms validate timezone/weekdays, preserve draft during polling, create daily/weekly/interval, edit, pause, resume, and confirm cancellation');

  await nav('chat');
  await page.locator('#prompt-input').fill('汇总演示养护待办并生成周报');
  await page.locator('#task-form [type="submit"]').click();
  const task=await settle(async()=>{const s=await getState();return s.tasks.find(t=>t.status==='completed');},'completed report');
  await page.locator('.file-download').waitFor();
  assert.equal(await page.locator('.file-download').count(),1);
  for(const format of ['docx','xlsx']){
    const downloaded=page.waitForEvent('download');
    await page.locator('[data-action="export-task"][data-format="'+format+'"]').click();
    const download=await downloaded, path=join(dataDir,'downloaded.'+format);
    await download.saveAs(path);
    const content=await readFile(path);
    assert.equal(content.subarray(0,2).toString(),'PK');
    assert.match(download.suggestedFilename(),new RegExp('\\.'+format+'$'));
    await page.locator('.office-download').filter({hasText:format}).waitFor();
  }
  await page.reload();
  await page.locator('.office-download').first().waitFor();
  assert.equal(await page.locator('.office-download').count(),2);
  assert.equal(await page.locator('.file-download').count(),1);
  assert.equal((await getState()).tasks.find(t=>t.id===task.id).exports.length,2);
  await shot('office-exports');
  log('Completed task exports real DOCX/XLSX downloads, preserves original download, and restores Office links after reload');

  await nav('settings');
  await page.locator('#desktop-settings').waitFor();
  await page.locator('#desktop-background').check();
  await page.locator('#model').fill('unsaved-model-preserved');
  await page.locator('#desktop-preferences-form [type="submit"]').click();
  await settle(()=>desktop.backgroundEnabled,'background preference');
  await page.locator('#desktop-preferences-form [type="submit"]').waitFor({state:'visible'});
  assert.equal(await page.locator('#model').inputValue(),'unsaved-model-preserved');
  assert.equal(await page.locator('#desktop-save-credentials').isDisabled(),true);
  assert.equal(saveCalls,0);
  await page.locator('#api-key').fill('FAKE_UI_V03_KEY_NOT_A_REAL_SECRET');
  await page.locator('#settings-form [type="submit"]').click();
  await settle(async()=> (await getState()).settings.hasApiKey,'fake key present only in runtime');
  await settle(async()=>await page.locator('#api-key').inputValue()==='','key field cleared after save');
  await page.locator('#desktop-credential-consent').check();
  await page.locator('#desktop-save-credentials').click();
  await settle(()=>saveCalls===1&&vault.stored,'explicit credential save');
  await page.locator('[data-action="forget-credentials"]').waitFor();
  assert.ok(savedSnapshot.entries.length);
  assert.equal(await page.locator('#desktop-credential-consent').isChecked(),false);
  assert.equal(await page.locator('#desktop-save-credentials').isDisabled(),true);
  assert.ok(!JSON.stringify(await getState()).includes('FAKE_UI_V03_KEY'));
  assert.deepEqual(await page.evaluate(()=>({local:Object.keys(localStorage),session:Object.keys(sessionStorage)})),{local:[],session:['luheng-active-chat']});
  assert.equal(await page.evaluate(()=>sessionStorage.getItem('luheng-active-chat')),task.id);
  assert.ok(!JSON.stringify(await page.evaluate(()=>Object.fromEntries(Object.keys(sessionStorage).map(k=>[k,sessionStorage.getItem(k)])))).includes('FAKE_UI_V03_KEY'));
  await page.locator('[data-action="forget-credentials"]').click();
  await page.keyboard.press('Escape');
  assert.equal(forgetCalls,0);
  await page.locator('[data-action="forget-credentials"]').click();
  await page.locator('[data-action="confirm-forget-credentials"]').click();
  await settle(()=>forgetCalls===1&&!vault.stored,'forget saved snapshot');
  await page.locator('.modal').waitFor({state:'hidden'});
  assert.equal((await getState()).settings.hasApiKey,true);
  await shot('desktop-settings');
  log('Desktop preferences preserve unrelated drafts; credentials require opt-in, never appear in state/browser storage, and forgetting retains runtime credentials');

  vault.available=false;vault.reason='TEST-ONLY secure backend unavailable';vault.restoreError=true;desktop.trayAvailable=false;
  await page.reload();
  await page.locator('#desktop-settings').waitFor();
  assert.equal(await page.locator('#desktop-background').isDisabled(),true);
  assert.equal(await page.locator('#desktop-credential-consent').isDisabled(),true);
  assert.equal(await page.locator('#desktop-save-credentials').isDisabled(),true);
  assert.match(await page.locator('#desktop-settings').innerText(),/不会退回明文存储/);
  assert.match(await page.locator('#desktop-settings').innerText(),/已保存的凭据未能恢复/);
  log('Unavailable OS storage and tray are disabled without a plaintext fallback');

  await page.setViewportSize({width:390,height:844});
  await page.goto(app.url+'/#schedules');
  await page.locator('.schedule-card').first().waitFor();
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'schedule page must fit mobile width');
  await page.locator('[data-action="add-schedule"]').first().click();
  await page.locator('#schedule-recurrence').selectOption('weekly');
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'schedule modal must fit mobile width');
  await shot('mobile-schedule');
  await page.keyboard.press('Escape');
  await page.goto(app.url+'/#settings');
  await page.locator('#desktop-settings').waitFor();
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'desktop settings must fit mobile width');
  log('Schedules, weekly editor, and desktop settings fit 390px width');

  standalone=await startServer({port:0,dataDir:join(dataDir,'standalone'),stepDelay:20});
  await page.goto(standalone.url+'/#settings');
  await page.locator('#settings-form').waitFor();
  assert.equal(await page.locator('#desktop-settings').count(),0);
  assert.equal(await page.locator('#desktop-background').count(),0);
  assert.match(await page.locator('#settings-form').innerText(),/仅保存在服务进程内存中/);
  log('Standalone server settings show no desktop-only controls');
  assert.deepEqual(errors,[]);
  console.log('PASS all v0.3 functional UI checks; screenshots: '+screenshots);
} finally {
  await browser?.close();
  await standalone?.close();
  await app?.close();
  await rm(dataDir,{recursive:true,force:true});
}
