import { MINIMUM_IDLE_MS, waitForMinimumIdle } from './real-idle-duration.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import { chromium } from 'playwright';
import { startServer } from '../server.mjs';
const dataDir=await mkdtemp(join(tmpdir(),'luheng-generic-ui-')),out=resolve(process.env.LUHENG_UI_QA_DIR||join(fileURLToPath(new URL('..',import.meta.url)),'artifacts','screenshots','generic-chat'));await mkdir(out,{recursive:true});
const calls=[],summary='# 一起把想法整理清楚\n\n已生成你请求的资料，文件卡片可以单独下载。\n\n## 内容要点\n- 用自己的 Skills 决定方法\n- 工具活动可展开查看\n- 重要操作仍需确认\n\n**这些是合成验收数据。**\n\n<script>window.injected=true</script>\n\n[不安全链接](javascript:alert(1))\n\n'+Array.from({length:28},(_,i)=>`${i+1}. 第 ${i+1} 项合成说明，用来验证长回复阅读与滚动保护。`).join('\n');
function tool(name,args,id){return {id,type:'function',function:{name,arguments:JSON.stringify(args)}};}
const completion=async request=>{calls.push(request);const results=request.messages.filter(message=>message.role==='tool');const latest=request.messages.filter(message=>message.role==='user').at(-1)?.content||'';if(latest.includes('生成')){if(!results.length)return {message:{role:'assistant',content:'',tool_calls:[tool('workspace_save',{name:'合成资料.md',content:'# 合成资料\nThis file is test-only.'},'ui-save')]}};return {message:{role:'assistant',content:'',tool_calls:[tool('agent_finish',{status:'completed',summary,claimType:'action',evidenceToolCallIds:['ui-save']},'ui-finish')]}};}return {message:{role:'assistant',content:'已保留上一轮的公开用户消息与最终回复；没有传递隐秘推理。'}};};
function submittedTaskCompleted(id){return String(chatTaskId)===String(id)&&taskById(id)?.status==='completed'&&!submitting&&!pollBusy;}
let app,browser;const errors=[];
try{
 app=await startServer({port:0,dataDir,stepDelay:1,completion});browser=await chromium.launch({headless:true,chromiumSandbox:true,executablePath:process.env.HIGHWAY_CHROMIUM_PATH||(existsSync('/usr/bin/chromium')?'/usr/bin/chromium':undefined)});const page=await browser.newPage({viewport:{width:1280,height:900}});page.on('pageerror',error=>errors.push(error.message));await page.goto(app.url);await page.waitForFunction(()=>loaded&&online&&!pollBusy);await page.locator('#local-access-form [data-action="local-defer"]').click();await page.locator('.modal').waitFor({state:'hidden'});await page.waitForFunction(()=>state.localAccess.configured&&!pollBusy);assert.equal(await page.locator('.send-button').isDisabled(),true);assert.equal(await page.locator('.suggestion-card').count(),0);assert.equal(await page.locator('.task-detail').count(),0);await page.screenshot({animations:'allow',caret:'initial',path:join(out,'desktop-empty.png')});
 await page.locator('#prompt-input').fill('等待配置的草稿');assert.equal(await page.locator('.send-button').isDisabled(),true);await page.locator('.welcome [data-nav="settings"]').click();await page.locator('#endpoint').fill('https://8.8.8.8/v1');await page.locator('#model').fill('synthetic-ui-model');await page.locator('#api-key').fill('SYNTHETIC-UI-KEY-NOT-REAL');await page.locator('#settings-form [type="submit"]').click();await page.waitForFunction(()=>state.settings.hasApiKey&&!settingsSaving);await page.locator('#nav [data-nav="chat"]').click();await page.waitForFunction(()=>view==='chat'&&!pollBusy);
 await page.locator('[data-action="skills"]').first().click();await page.locator('#skill-file').setInputFiles({name:'SKILL.md',mimeType:'text/markdown',buffer:Buffer.from('---\nname: 自定义方法\ndescription: 合成用户工作流，仅用于验收\n---\n按用户的目标组织资料，不使用固定业务模板。\n')});await page.waitForFunction(()=>state.skills?.length===1);await page.locator('[data-skill-id]').check();await page.screenshot({animations:'allow',caret:'initial',path:join(out,'desktop-skills.png')});await page.locator('.modal [data-action="close-modal"]').first().click();
 await page.locator('[data-action="capabilities"]').first().click();await page.waitForFunction(()=>!capabilityLoading);assert.ok(await page.locator('.capability-row').count()>4);assert.match(await page.locator('.capability-list').innerText(),/可用|权限受限|未配置/);await page.screenshot({animations:'allow',caret:'initial',path:join(out,'desktop-tools.png')});await page.keyboard.press('Escape');
 await page.locator('#prompt-input').fill('请生成一份通用合成资料');const promptNode=await page.locator('#prompt-input').evaluate(element=>{window.testPrompt=element;return true;});const firstAccepted=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname==='/api/tasks');await page.locator('.send-button').click();const firstTask=await(await firstAccepted).json();assert.equal(typeof firstTask.id,'string');await page.waitForFunction(submittedTaskCompleted,firstTask.id);await page.evaluate(()=>loadState(true));assert.equal(await page.evaluate(()=>testPrompt===document.querySelector('#prompt-input')),true);assert.equal(await page.locator('#prompt-input').inputValue(),'');assert.match(await page.locator('.prompt-block').innerText(),/通用合成资料/);assert.equal(await page.locator('.task-result script').count(),0);assert.equal(await page.locator('.task-result a[href^="javascript:"]').count(),0);assert.equal(await page.locator('.file-download').count(),1);assert.equal(await page.locator('.execution-disclosure').evaluate(e=>e.open),false);assert.ok(calls[0].messages.some(message=>message.content.includes('自定义方法')));const download=await page.request.get(new URL(await page.locator('.file-download').getAttribute('href'),app.url).href);assert.equal(download.status(),200);assert.match(await download.text(),/test-only/);
 await page.evaluate(()=>{const thread=document.querySelector('.chat-thread');thread.scrollTop=0;});await page.screenshot({animations:'allow',caret:'initial',path:join(out,'desktop-conversation.png')});
 // Actual browser DOM and native selections; IME lifecycle uses explicit
 // CompositionEvents, not a claim of physical OS input-method validation.
 await page.locator('#prompt-input').fill('输入中的中文草稿');
 await page.locator('#prompt-input').focus();
 await page.evaluate(()=>{
   const input=document.querySelector('#prompt-input');input.setSelectionRange(2,5);
   input.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:'中'}));
   window.testThread=document.querySelector('.chat-thread');window.testArticle=document.querySelector('.chat-turn');
   window.testThread.scrollTop=35;window.testScroll=window.testThread.scrollTop;
 });
 for(let n=0;n<30;n++){
   app.store.put('audit','synthetic-progress',{id:'synthetic-progress',action:'test-progress',at:new Date().toISOString(),detail:'composition tick '+n});
   await page.evaluate(()=>loadState(true));
 }
 assert.equal(await page.evaluate(()=>testPrompt===document.querySelector('#prompt-input')&&testArticle===document.querySelector('.chat-turn')&&testThread===document.querySelector('.chat-thread')),true);
 assert.equal(await page.locator('#prompt-input').inputValue(),'输入中的中文草稿');
 assert.deepEqual(await page.locator('#prompt-input').evaluate(e=>[e.selectionStart,e.selectionEnd]),[2,5]);
 assert.equal(await page.evaluate(()=>document.activeElement===testPrompt),true);
 assert.equal(await page.evaluate(()=>testThread.scrollTop),await page.evaluate(()=>testScroll));
 await page.evaluate(()=>document.querySelector('#prompt-input').dispatchEvent(new CompositionEvent('compositionend',{bubbles:true})));
 // A native transition to reading output may alter dormant textarea offsets.
 // Capture that intentional gesture before any changed background state, then
 // require the resulting input offsets and native text Range to remain exact.
 await page.evaluate(()=>{
   const input=document.querySelector('#prompt-input');input.blur();
   const result=document.querySelector('.task-result'),walker=document.createTreeWalker(result,NodeFilter.SHOW_TEXT);let text;
   while(text=walker.nextNode())if(text.data.includes('一起把想法'))break;
   if(!text)throw new Error('Selectable assistant heading was not rendered');
   const range=document.createRange();range.setStart(text,0);range.setEnd(text,Math.min(4,text.length));
   const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);
   window.selectedReply=selection.toString();window.selectedReplyNode=text;
   window.selectedReplyOffsets=[range.startOffset,range.endOffset];
 });
 await page.waitForTimeout(150);
 const selectionGesture=await page.evaluate(()=>{
   window.readingInputOffsets=[testPrompt.selectionStart,testPrompt.selectionEnd];
   window.testScroll=testThread.scrollTop;
   return {inputOffsets:readingInputOffsets,selectedOutput:selectedReply,activeElement:document.activeElement.tagName};
 });
 assert.equal(await page.evaluate(()=>window.getSelection().toString()),selectionGesture.selectedOutput);
 for(let n=0;n<30;n++){
   app.store.put('audit','synthetic-progress',{id:'synthetic-progress',action:'test-progress',at:new Date().toISOString(),detail:'reading tick '+n});
   await page.evaluate(()=>loadState(true));
 }
 assert.equal(await page.evaluate(()=>testPrompt===document.querySelector('#prompt-input')&&testArticle===document.querySelector('.chat-turn')&&testThread===document.querySelector('.chat-thread')),true);
 assert.equal(await page.locator('#prompt-input').inputValue(),'输入中的中文草稿');
 assert.deepEqual(await page.locator('#prompt-input').evaluate(e=>[e.selectionStart,e.selectionEnd]),selectionGesture.inputOffsets);
 assert.equal(await page.evaluate(()=>{const sel=window.getSelection(),r=sel.getRangeAt(0);return sel.toString()===selectedReply&&r.startContainer===selectedReplyNode&&r.endContainer===selectedReplyNode&&r.startOffset===selectedReplyOffsets[0]&&r.endOffset===selectedReplyOffsets[1];}),true);
 assert.equal(await page.evaluate(()=>testThread.scrollTop),await page.evaluate(()=>testScroll));
 await page.evaluate(()=>window.getSelection().removeAllRanges());
 // Follow-up is backed by actual previousTaskId and model history.
 await page.locator('#prompt-input').fill('继续，解释上一轮的方法');const secondAccepted=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname==='/api/tasks');await page.locator('.send-button').click();const secondTask=await(await secondAccepted).json();assert.equal(typeof secondTask.id,'string');assert.notEqual(secondTask.id,firstTask.id);assert.equal(secondTask.previousTaskId,firstTask.id);await page.waitForFunction(submittedTaskCompleted,secondTask.id);await page.evaluate(()=>loadState(true));assert.equal(await page.locator('.chat-turn').count(),2);assert.ok(calls.at(-1).messages.some(message=>message.role==='user'&&message.content==='请生成一份通用合成资料'));assert.ok(calls.at(-1).messages.some(message=>message.role==='assistant'&&message.content.includes('一起把想法')));
 // App's real idle polling for 60 seconds: zero subtree/chrome mutations.
 await page.locator('#prompt-input').fill('保留此草稿');await page.evaluate(()=>{window.idleMutations=0;window.idleMutationRecords=[];window.idleObserver=new MutationObserver(records=>{idleMutations+=records.length;for(const r of records)if(idleMutationRecords.length<160)idleMutationRecords.push({type:r.type,target:r.target.id||r.target.nodeName,attribute:r.attributeName,oldValue:r.oldValue,newValue:r.attributeName?r.target.getAttribute(r.attributeName):null,added:r.addedNodes.length,removed:r.removedNodes.length});});idleObserver.observe(document.querySelector('#main'),{subtree:true,childList:true,characterData:true,attributes:true,attributeOldValue:true});window.idleInput=document.querySelector('#prompt-input');window.idleTop=document.querySelector('.chat-thread').scrollTop;});const idleTiming=await waitForMinimumIdle(ms=>page.waitForTimeout(ms));const idleElapsedMs=idleTiming.elapsedMs;const idle=await page.evaluate(()=>{idleObserver.disconnect();return {mutationRecords:idleMutationRecords,mutations:idleMutations,sameInput:idleInput===document.querySelector('#prompt-input'),draft:idleInput.value,scroll:document.querySelector('.chat-thread').scrollTop,top:idleTop};});await writeFile(join(out,'idle-observation.json'),JSON.stringify({...idleTiming,...idle},null,2));assert.ok(idleElapsedMs>=MINIMUM_IDLE_MS,JSON.stringify(idleTiming));assert.ok(idleTiming.monotonicElapsedMs>=MINIMUM_IDLE_MS,JSON.stringify(idleTiming));assert.equal(idle.mutations,0);assert.equal(idle.sameInput,true);assert.equal(idle.draft,'保留此草稿');assert.equal(idle.scroll,idle.top);
 await page.setViewportSize({width:360,height:780});await page.evaluate(()=>{document.querySelector('.chat-thread').scrollTop=0;});await page.screenshot({animations:'allow',caret:'initial',path:join(out,'mobile-conversation.png')});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false);const composer=await page.locator('.composer').boundingBox();assert.ok(composer.x>=0&&composer.x+composer.width<=360&&composer.y+composer.height<=780);await page.locator('[data-action="new-task"]').last().click();await page.waitForFunction(()=>!pollBusy&&view==='chat');assert.equal(await page.locator('.chat-turn').count(),0);await page.screenshot({animations:'allow',caret:'initial',path:join(out,'mobile-empty.png')});await page.locator('#prompt-input').focus();await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement.dataset.action),'capabilities');assert.deepEqual(errors,[]);const report={passed:true,idle:{...idleTiming,...idle},screenshots:['desktop-empty.png','desktop-skills.png','desktop-tools.png','desktop-conversation.png','mobile-conversation.png','mobile-empty.png'],scope:'Owned temporary data; explicit synthetic API provider; actual desktop/360px Chromium layout; CompositionEvent lifecycle contract, not physical IME hardware',selectionGesture,tests:['unconfigured-disabled','skills-import-selection','capability-contract','safe-markdown','real-artifact-download','stable-DOM','IME-selection','manual-scroll','real-follow-up-history','60s-zero-idle-mutations','360px-layout','keyboard-tab'],errors};await writeFile(join(out,'ui-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}catch(error){
 const message=error.stack||String(error);console.error(message);
 const pages=browser?.contexts().flatMap(context=>context.pages())||[];
 await pages[0]?.screenshot({animations:'allow',caret:'initial',path:join(out,'failure.png')}).catch(()=>{});
 await writeFile(join(out,'ui-failure.json'),JSON.stringify({passed:false,error:message,errors,scope:'Owned temporary data and explicit synthetic API provider; actual Chromium UI'},null,2));
 throw error;
}finally{await browser?.close();await app?.close();await rm(dataDir,{recursive:true,force:true});}
