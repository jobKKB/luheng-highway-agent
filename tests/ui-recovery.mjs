import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {chromium} from 'playwright';
import {startServer} from '../server.mjs';

// All writes stay in a fresh synthetic local database. No external service,
// real mailbox, model credential, shared browser or screenshot is used.
const dir=await mkdtemp('/tmp/luheng-ui-recovery-');
const out=resolve(process.env.HIGHWAY_RECOVERY_OUT||'artifacts/recovery');
const checks=[],failures=[],browserErrors=[];
let app,browser;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,label){const end=Date.now()+12000;while(Date.now()<end){if(await fn())return;await pause(40);}throw new Error('Timed out: '+label);}
const state=async page=>await(await page.request.get(app.url+'/api/state')).json();
const taskCount=async page=>(await state(page)).tasks.length;
const reminderCount=async page=>(await state(page)).reminders.length;
const submit=page=>page.locator('#task-form [type="submit"]');
async function nav(page,name){if(['agents','knowledge','schedules','mail','browser','audit'].includes(name)&&await page.locator('#nav-tools').isHidden())await page.locator('[data-action="toggle-tools"]').click();await page.locator('#nav [data-nav="'+name+'"]').click();await page.locator('#main[data-view="'+name+'"]').waitFor();}
async function openReminder(page){await page.locator('#notification-button').click();await page.locator('#modal-root [data-action="reminder"]').click();await page.locator('#reminder-title').waitFor();}
async function repeatedSubmit(page,selector='#task-form'){await page.locator(selector).evaluate(form=>{form.querySelector('[type="submit"]').click();form.querySelector('[type="submit"]').click();form.requestSubmit();form.requestSubmit();});}
async function holdPost(page,path,mode='success'){
 let release,entered,posts=0;const gate=new Promise(r=>release=r),seen=new Promise(r=>entered=r);
 const handler=async route=>{if(route.request().method()!=='POST')return route.continue();posts++;let response;if(mode==='success')response=await route.fetch();entered();await gate;if(mode==='success')await route.fulfill({response});else if(mode==='network')await route.abort('failed');else await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'RECOVERY_TEST_SERVICE_UNAVAILABLE'})});};
 await page.route('**'+path,handler);
 return {seen,release,posts:()=>posts,dispose:async()=>{release();await page.unroute('**'+path,handler);}};
}
async function run(name,body){if(process.env.HIGHWAY_RECOVERY_CASE&&!name.includes(process.env.HIGHWAY_RECOVERY_CASE))return;let context,page;try{context=await browser.newContext({viewport:{width:1440,height:1000},locale:'zh-CN',reducedMotion:'reduce'});page=await context.newPage();page.on('pageerror',e=>browserErrors.push({case:name,message:e.message}));await context.route('**/*',route=>{const url=new URL(route.request().url());return url.origin===new URL(app.url).origin?route.continue():route.abort('blockedbyclient');});await page.goto(app.url);await page.locator('#prompt-input').waitFor();await body(page);checks.push(name);console.log('PASS '+name);}catch(error){failures.push({name,error:error.stack||error.message});console.error('FAIL '+name+'\n'+(error.stack||error.message));}finally{await context?.close();}}
try{
 await mkdir(out,{recursive:true});app=await startServer({port:0,dataDir:dir,stepDelay:15});
 browser=await chromium.launch({executablePath:process.env.HIGHWAY_CHROMIUM_PATH||'/usr/bin/chromium',headless:true,chromiumSandbox:true});
 await run('Initial chat has tools, overview, recent records and task options collapsed',async page=>{
  assert.equal(await page.locator('#nav-tools').isHidden(),true);assert.equal(await page.locator('#home-overview').isHidden(),true);assert.equal(await page.locator('#composer-options').isHidden(),true);assert.equal(await page.locator('.recent-section').getAttribute('open'),null);assert.equal(await submit(page).isEnabled(),true);
 });
 for(const mode of ['http','network'])await run(mode+' task rejection preserves draft, reenables submit, and explicit retry creates exactly one task',async page=>{
  const before=await taskCount(page),draft='虚构恢复回归：'+mode+' 汇总演示养护周报';let attempts=0;
  await page.route('**/api/tasks',async route=>{if(route.request().method()!=='POST')return route.continue();attempts++;if(attempts>1)return route.continue();if(mode==='network')return route.abort('failed');return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'RECOVERY_TEST_SERVICE_UNAVAILABLE'})});});
  await page.locator('#prompt-input').fill(draft);await submit(page).click();await page.locator('#toast-root .toast.error').waitFor();await until(()=>submit(page).isEnabled(),'submit recovers');assert.equal(await page.locator('#prompt-input').inputValue(),draft);assert.equal(await taskCount(page),before);
  await repeatedSubmit(page);await until(async()=>await taskCount(page)===before+1,'one retry task');await until(()=>submit(page).isEnabled(),'retry completes');await pause(150);assert.equal(attempts,2);assert.equal(await taskCount(page),before+1);
 });
 await run('Accepted task with lost response retries once with one persisted task; identical new submission stays independent',async page=>{
  const before=await taskCount(page),payloads=[];let posts=0;
  await page.route('**/api/tasks',async route=>{if(route.request().method()!=='POST')return route.continue();posts++;payloads.push(route.request().postDataJSON());if(posts===1){await route.fetch();return route.abort('failed');}return route.continue();});
  const draft='虚构回归：响应丢失后安全重试';await page.locator('#prompt-input').fill(draft);await submit(page).click();await page.locator('#toast-root .toast.error').waitFor();await until(()=>submit(page).isEnabled(),'lost-response form recovers');assert.equal(await page.locator('#prompt-input').inputValue(),draft);assert.equal(await taskCount(page),before+1);
  await repeatedSubmit(page);await until(()=>submit(page).isEnabled(),'accepted retry completes');await pause(150);assert.equal(posts,2);assert.equal(await taskCount(page),before+1,'retry must not duplicate an already accepted task');assert.ok(payloads[0].submissionId,'submission has a unique key');assert.equal(payloads[1].submissionId,payloads[0].submissionId);
  await page.locator('.new-task-button').click();await page.locator('#prompt-input').fill(draft);await submit(page).click();await until(()=>submit(page).isEnabled(),'intentional new task completes');assert.equal(posts,3);assert.equal(await taskCount(page),before+2);assert.notEqual(payloads[2].submissionId,payloads[0].submissionId);
 });
 await run('Held task submission ignores duplicate clicks and requestSubmit calls',async page=>{
  const before=await taskCount(page),hold=await holdPost(page,'/api/tasks');try{await page.locator('#prompt-input').fill('虚构回归：单次提交生成周报');await repeatedSubmit(page);await hold.seen;assert.equal(await submit(page).isDisabled(),true);assert.equal(hold.posts(),1);await page.locator('#task-form').evaluate(form=>{form.requestSubmit();form.requestSubmit();});await pause(100);assert.equal(hold.posts(),1);hold.release();await until(()=>submit(page).isEnabled(),'held response completes');assert.equal(await taskCount(page),before+1);}finally{await hold.dispose();}
 });
 for(const mode of ['success','http'])await run('Delayed task '+mode+' preserves newer chat draft, Settings navigation and unsaved settings',async page=>{
  const hold=await holdPost(page,'/api/tasks',mode);try{await page.locator('#prompt-input').fill('虚构回归：原始任务');await submit(page).click();await hold.seen;await page.locator('#prompt-input').fill('下一份草稿，必须保留');await nav(page,'settings');await page.locator('#model').fill('UNSAVED-RECOVERY-MODEL');hold.release();await page.locator('#toast-root .toast').waitFor();await pause(100);assert.equal(await page.locator('#settings-form').isVisible(),true);assert.equal(await page.locator('#model').inputValue(),'UNSAVED-RECOVERY-MODEL');await nav(page,'chat');assert.equal(await page.locator('#prompt-input').inputValue(),'下一份草稿，必须保留');assert.equal(await submit(page).isEnabled(),true);}finally{await hold.dispose();}
 });
 await run('Delayed task response preserves newer task-record selection',async page=>{
  const old=(await state(page)).tasks[0];assert.ok(old,'earlier synthetic task exists');const hold=await holdPost(page,'/api/tasks');try{await page.locator('#prompt-input').fill('虚构回归：不应抢走当前记录');await submit(page).click();await hold.seen;await nav(page,'tasks');await page.locator('.task-card[data-task="'+old.id+'"]').click();assert.equal(await page.locator('.task-card.selected').getAttribute('data-task'),old.id);hold.release();await page.locator('#toast-root .toast').waitFor();await pause(150);assert.equal(await page.locator('.task-card.selected').getAttribute('data-task'),old.id);}finally{await hold.dispose();}
 });
 await run('New-task keyboard navigation dismisses an open modal and restores usable chat',async page=>{
  await page.locator('#prompt-input').fill('弹窗下方的未提交草稿');await openReminder(page);await page.keyboard.press('Control+k');assert.equal(await page.locator('.modal').count(),0);assert.equal(await page.locator('body').evaluate(e=>e.style.overflow),'');assert.equal(await page.locator('#prompt-input').inputValue(),'弹窗下方的未提交草稿');await until(()=>page.locator('#prompt-input').evaluate(e=>e===document.activeElement),'chat focus');
 });
 await run('Reminder validation error preserves inputs, reenables submit, and Cancel restores focus',async page=>{
  await openReminder(page);await page.locator('#reminder-title').fill('虚构回归：保留未保存提醒');await page.locator('#reminder-due').fill('2000-01-01T12:00');await page.locator('#reminder-form [type="submit"]').click();await page.locator('#reminder-form .modal-error').filter({hasText:'未来'}).waitFor();assert.equal(await page.locator('#reminder-title').inputValue(),'虚构回归：保留未保存提醒');assert.equal(await page.locator('#reminder-form [type="submit"]').isEnabled(),true);await page.locator('#reminder-form [data-action="close-modal"]').click();assert.equal(await page.locator('.modal').count(),0);assert.equal(await page.locator('body').evaluate(e=>e.style.overflow),'');assert.equal(await page.locator('#notification-button').evaluate(e=>e===document.activeElement),true);
 });
 await run('Reminder request error supports one explicit retry without duplicate creation',async page=>{
  let posts=0;const before=await reminderCount(page);await page.route('**/api/reminders',route=>{if(route.request().method()!=='POST')return route.continue();posts++;if(posts===1)return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'RECOVERY_TEST_REMINDER_FAILURE'})});return route.continue();});await openReminder(page);await page.locator('#reminder-title').fill('虚构回归：提醒重试');await page.locator('#reminder-form [type="submit"]').click();await page.locator('#reminder-form .modal-error').filter({hasText:'RECOVERY_TEST_REMINDER_FAILURE'}).waitFor();assert.equal(await page.locator('#reminder-title').inputValue(),'虚构回归：提醒重试');assert.equal(await page.locator('#reminder-form [type="submit"]').isEnabled(),true);assert.equal(await reminderCount(page),before);await repeatedSubmit(page,'#reminder-form');await page.locator('.modal').waitFor({state:'hidden'});assert.equal(posts,2);assert.equal(await reminderCount(page),before+1);
 });
 await run('Back/Forward closes modal without reopening it or erasing chat draft',async page=>{
  await page.locator('#prompt-input').fill('浏览器前进后退仍保留');await nav(page,'settings');await openReminder(page);await page.goBack();await page.locator('#prompt-input').waitFor();assert.equal(await page.locator('.modal').count(),0);assert.equal(await page.locator('#prompt-input').inputValue(),'浏览器前进后退仍保留');await page.goForward();await page.locator('#settings-form').waitFor();assert.equal(await page.locator('.modal').count(),0);assert.equal(await page.locator('body').evaluate(e=>e.style.overflow),'');
 });
 await run('Reminder saved above Settings preserves unsaved fields behind its modal',async page=>{
  await nav(page,'settings');await page.locator('#model').fill('SETTINGS-DRAFT-BEHIND-MODAL');await openReminder(page);await page.locator('#reminder-title').fill('虚构回归：设置页上方保存提醒');await page.locator('#reminder-form [type="submit"]').click();await page.locator('.modal').waitFor({state:'hidden'});assert.equal(await page.locator('#model').inputValue(),'SETTINGS-DRAFT-BEHIND-MODAL');
 });
 await run('Closing pending reminder and navigating preserves newer unsaved settings on success',async page=>{
  const hold=await holdPost(page,'/api/reminders');try{await openReminder(page);await page.locator('#reminder-title').fill('虚构回归：迟到提醒响应');await page.locator('#reminder-form [type="submit"]').click();await hold.seen;await page.keyboard.press('Escape');await nav(page,'settings');await page.locator('#model').fill('DO-NOT-ERASE-NEWER-SETTINGS');hold.release();await page.locator('#toast-root .toast').filter({hasText:'提醒已保存'}).waitFor();assert.equal(await page.locator('#model').inputValue(),'DO-NOT-ERASE-NEWER-SETTINGS');assert.equal(await page.locator('.modal').count(),0);}finally{await hold.dispose();}
 });
 await run('Closing pending reminder and reopening leaves new modal draft/error state intact',async page=>{
  const hold=await holdPost(page,'/api/reminders','http');try{await openReminder(page);await page.locator('#reminder-title').fill('虚构回归：旧请求');await page.locator('#reminder-form [type="submit"]').click();await hold.seen;await page.keyboard.press('Escape');await openReminder(page);await page.locator('#reminder-title').fill('新提醒草稿');hold.release();await pause(200);assert.equal(await page.locator('#reminder-title').inputValue(),'新提醒草稿');assert.equal(await page.locator('#reminder-form .modal-error').textContent(),'');assert.equal(await page.locator('#reminder-form [type="submit"]').isEnabled(),true);}finally{await hold.dispose();}
 });
 if(browserErrors.length)failures.push({name:'No JavaScript page errors',errors:browserErrors});else checks.push('No JavaScript page errors');
}catch(error){failures.push({name:'Harness launch',error:error.stack||error.message});console.error(error.stack||error.message);}
finally{await browser?.close();await app?.close();await rm(dir,{recursive:true,force:true});await mkdir(out,{recursive:true});await writeFile(join(out,'ui-recovery-results.json'),JSON.stringify({ok:failures.length===0,checks,failures,scope:'Isolated synthetic local data with mocked failures; no real providers, keys, email or screenshots'},null,2));console.log('RESULT '+checks.length+' passed, '+failures.length+' failed; '+join(out,'ui-recovery-results.json'));if(failures.length)process.exitCode=1;}
