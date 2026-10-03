import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {chromium} from 'playwright';
import {startServer} from '../server.mjs';
const dir=await mkdtemp(join(tmpdir(),'luheng-v04-ui-')),out=resolve('artifacts/redesign');
const checks=[],errors=[];let app,browser,page;
const pass=m=>{checks.push(m);console.log('PASS '+m);};
const state=async()=>await(await page.request.get(app.url+'/api/state')).json();
const waitFor=async(fn,label)=>{const end=Date.now()+12000;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,80));}throw new Error(label);};
const nav=async name=>{if(await page.locator('.mobile-menu').isVisible()&&!((await page.locator('body').getAttribute('class'))||'').includes('nav-open'))await page.locator('.mobile-menu').click();if(['agents','knowledge','schedules','mail','browser','audit'].includes(name)&&await page.locator('#nav-tools').isHidden())await page.locator('[data-action="toggle-tools"]').click();await page.locator('#nav [data-nav="'+name+'"]').click();};
const shot=async name=>{await page.locator('#toast-root .toast').waitFor({state:'hidden',timeout:10000});await page.screenshot({path:join(out,name+'.png'),animations:'disabled'});};
try{
 await mkdir(out,{recursive:true});app=await startServer({port:0,dataDir:dir,stepDelay:15});
 browser=await chromium.launch({executablePath:process.env.HIGHWAY_CHROMIUM_PATH||(existsSync('/usr/bin/chromium')?'/usr/bin/chromium':undefined),headless:true,chromiumSandbox:true});
 page=await browser.newPage({viewport:{width:1440,height:1000},locale:'zh-CN',reducedMotion:'reduce'});page.on('pageerror',e=>errors.push(e.message));
 await page.goto(app.url);await page.locator('#prompt-input').waitFor();if((await page.request.get(app.url+'/api/local-access/state')).ok()){await page.locator('[data-action="local-defer"]').waitFor({state:'visible',timeout:3000}).then(()=>page.locator('[data-action="local-defer"]').click()).catch(()=>{});}await page.locator('#prompt-input').waitFor();
 assert.equal(await page.locator('#home-overview').isHidden(),true);assert.equal(await page.locator('#nav-tools').isHidden(),true);assert.equal(await page.locator('.recent-section').getAttribute('open'),null);assert.equal(await page.locator('#composer-options').isHidden(),true);pass('Clean initial chat: overview, tools, recent records and task options collapsed');
 await shot('Luheng-v0.4-Desktop');
 await page.locator('#prompt-input').fill('未发送的测试草稿，只用于界面回归');
 await page.locator('.overview-toggle').click();assert.match(await page.locator('#prompt-input').inputValue(),/未发送/);
 await page.locator('.recent-disclosure').click();await page.locator('#prompt-input').focus();
 await page.request.post(app.url+'/api/memories',{data:{title:'界面刷新测试（虚构）',content:'仅用于检查轮询，不是真实业务资料。',source:'v0.4本地测试',scope:'workspace'}});
 await page.waitForTimeout(2250);assert.match(await page.locator('#prompt-input').inputValue(),/未发送/);
 await page.locator('.workspace-caption').click();await page.waitForTimeout(150);
 assert.equal(await page.locator('#home-overview').isVisible(),true);assert.notEqual(await page.locator('.recent-section').getAttribute('open'),null);pass('Draft and disclosure state survive polling and focus changes');
 await shot('Luheng-v0.4-Tools');
 await nav('settings');await page.locator('#model').fill('UNSAVED-LOCAL-TEST');await page.keyboard.press('Control+k');await page.locator('#prompt-input').waitFor();assert.match(await page.locator('#prompt-input').inputValue(),/未发送/);pass('Intentional keyboard navigation works from focused settings without erasing chat draft');
 await page.goto(app.url);await page.locator('#prompt-input').waitFor();await nav('tasks');await page.goBack();await page.locator('#prompt-input').waitFor();pass('Back to initial empty URL hash restores chat');
 await page.locator('.overview-toggle').click();await page.locator('.suggestion-card[data-action="reminder"]').click();await page.locator('#reminder-title').waitFor();await page.keyboard.press('Escape');await page.locator('.modal').waitFor({state:'hidden'});assert.equal(await page.locator('.suggestion-card[data-action="reminder"]').evaluate(e=>e===document.activeElement),true);pass('Modal Escape returns focus to its original action');
 // Hold one actual local task response; newer draft/navigation must win.
 let release,responseHeld;const held=new Promise(r=>responseHeld=r);const gate=new Promise(r=>release=r);let posts=0;
 await page.route('**/api/tasks',async route=>{if(route.request().method()!=='POST')return route.continue();posts++;const response=await route.fetch();responseHeld();await gate;await route.fulfill({response});});
 await page.locator('#prompt-input').fill('汇总演示养护待办并生成周报');await page.locator('#task-form [type="submit"]').click();await held;
 assert.equal(await page.locator('#task-form [type="submit"]').isDisabled(),true);await page.locator('#prompt-input').fill('请求处理中新增的下一份草稿');await nav('settings');release();await waitFor(async()=>posts===1&&(await state()).tasks.length===1,'one task');await page.waitForTimeout(250);assert.equal(await page.locator('#settings-form').isVisible(),true);await nav('chat');assert.match(await page.locator('#prompt-input').inputValue(),/新增/);assert.equal(posts,1);await page.unroute('**/api/tasks');pass('Delayed task response preserves newer navigation/draft; repeated submission guarded');
 // Fresh independent task, actual local result and export controls.
 await page.locator('#prompt-input').fill('汇总演示养护待办并生成周报');await page.locator('#task-form [type="submit"]').click();await page.locator('.chat-thread .file-download').waitFor();
 assert.equal(await page.locator('#task-form [type="submit"]').isEnabled(),true);if(await page.locator('.overview-toggle').getAttribute('aria-expanded')==='true')await page.locator('.overview-toggle').click();await page.locator('.chat-thread').evaluate(e=>e.scrollTop=0);await shot('Luheng-v0.4-Conversation');
 for(const size of [{width:900,height:620},{width:1180,height:812},{width:1440,height:1000},{width:1920,height:1080},{width:390,height:844}]){
  await page.setViewportSize(size);
  // A polling render may replace the form between locator resolution and layout
  // measurement. Observe the current DOM and viewport together, and wait for a
  // visible composer rather than dereferencing a transient detached element.
  await waitFor(()=>page.evaluate(()=>{
   const button=document.querySelector('.send-button'),box=button?.getBoundingClientRect();
   return !!box&&box.width>0&&box.height>0&&box.y>=0&&box.bottom<=innerHeight&&document.documentElement.scrollWidth<=innerWidth;
  }),'composer visible without horizontal overflow '+JSON.stringify(size));
  console.log('PASS viewport '+size.width+'×'+size.height);
 }
 pass('Conversation composer remains visible without horizontal overflow at 900×620, 1180×812, 1440×1000, 1920×1080 and 390×844');
 await page.goto(app.url);await page.locator('#prompt-input').waitFor();assert.equal(await page.locator('.chat-thread .file-download').count(),1);pass('Active conversation and persisted output restore after reload');await page.locator('.mobile-menu').click();await page.locator('.new-task-button').click();await shot('Luheng-v0.4-Mobile');
 await page.setViewportSize({width:1440,height:1000});await nav('agents');await shot('Luheng-v0.4-Agents');await nav('settings');
 await page.route('**/api/settings/test',r=>r.fulfill({status:400,contentType:'application/json',body:JSON.stringify({error:'模型服务拒绝建立连接，请检查服务地址或服务是否可用',code:'MODEL_NETWORK_REFUSED'})}));
 await page.locator('[data-action="test-api"]').click();await page.locator('#settings-status').filter({hasText:'MODEL_NETWORK_REFUSED'}).waitFor();assert.equal(await page.locator('[data-action="copy-connection-diagnostic"]').isVisible(),true);pass('Sanitized connection error category is readable and diagnostic-copy control is available');
 await page.unroute('**/api/settings/test');
 const hidpi=await browser.newPage({viewport:{width:1180,height:812},deviceScaleFactor:2,locale:'zh-CN',reducedMotion:'reduce'});await hidpi.goto(app.url);await hidpi.locator('#prompt-input').waitFor();assert.equal(await hidpi.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await hidpi.screenshot({path:join(out,'Luheng-v0.4-HiDPI.png'),animations:'disabled'});await hidpi.close();pass('2× browser device-scale rendering verified at 1180×812 logical pixels');
 assert.deepEqual(errors,[]);pass('No JavaScript page errors');
}catch(e){errors.push(e.stack||e.message);console.error('FAIL',e.stack||e.message);if(page)await shot('v04-failure').catch(()=>{});process.exitCode=1;}
finally{await browser?.close();await app?.close();await rm(dir,{recursive:true,force:true});await writeFile(join(out,'ui-v04-results.json'),JSON.stringify({ok:!errors.length,checks,errors,scope:'Independent synthetic local data only; no user credentials or real provider calls'},null,2));}
