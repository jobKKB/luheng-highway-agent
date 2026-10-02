import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {startServer} from '../server.mjs';
import {callModel,validateEndpoint} from '../lib/model.mjs';

const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,{timeout=20000,description='expected condition'}={}) {
 const deadline=Date.now()+timeout;
 while(Date.now()<deadline){const value=await fn();if(value)return value;await wait(20);}
 throw new Error(`Timed out waiting for ${description}`);
}
async function harness(t,options={}){
 const dataDir=await mkdtemp(join(tmpdir(),'luheng-test-'));
 let app=await startServer({port:0,dataDir,stepDelay:1,...options}),cookie='';
 async function login(){const r=await fetch(app.url+'/');cookie=r.headers.get('set-cookie')?.split(';')[0];assert.ok(cookie,'index establishes HttpOnly local session');}
 await login();
 const h={get app(){return app;},dataDir,get cookie(){return cookie;},async request(path,{method='GET',body,headers={},origin=true,auth=true}={}){return fetch(app.url+path,{method,headers:{...(auth?{cookie}:{}),...(method!=='GET'?{'content-type':'application/json',...(origin?{origin:app.url}:{})}:{}),...headers},...(body!==undefined?{body:JSON.stringify(body)}:{})});},async json(path,options){const r=await h.request(path,options);const value=await r.json();assert.equal(r.status,options?.status??200,JSON.stringify(value));return value;},async post(path,body={},status=200){return h.json(path,{method:'POST',body,status});},async task(prompt,options={}){return h.post('/api/tasks',{prompt,...options},201);},async terminal(id){return until(async()=>{const v=await h.json('/api/tasks/'+id);return ['completed','cancelled','failed','rejected'].includes(v.status)&&v;},{description:'terminal task '+id});},async awaiting(id){return until(async()=>{const v=await h.json('/api/tasks/'+id);if(v.status==='failed')throw new Error(v.error);return v.status==='awaiting_approval'&&v;},{description:'browser approval '+id});},async restart(delay=0){await app.close();if(delay)await wait(delay);app=await startServer({port:0,dataDir,stepDelay:1,...options});await login();},async state(){return h.json('/api/state');}};
 t.after(async()=>{await app.close();await rm(dataDir,{recursive:true,force:true});});
 return h;
}
function rawRequest(url,{path='/health',method='GET',headers={},body}={}){return new Promise((resolve,reject)=>{const req=http.request(new URL(path,url),{method,headers},res=>{let text='';res.setEncoding('utf8');res.on('data',s=>text+=s);res.on('end',()=>resolve({status:res.statusCode,text,headers:res.headers}));});req.on('error',reject);req.end(body);});}
async function approvalFor(h,id){return (await h.state()).approvals.find(a=>a.taskId===id);}
async function files(dir){let result=[];for(const name of await readdir(dir)){const path=join(dir,name);if((await stat(path)).isDirectory())result.push(...await files(path));else result.push(path);}return result;}

test('report, source citations, artifact, knowledge and audit survive restart',async t=>{
 const h=await harness(t);
 const memory=await h.post('/api/memories',{title:'Fabricated test note',content:'TEST-ONLY fact 31415',source:'local integration test'},201);
 const created=await h.task('整理本周养护工作简报，列出材料来源');
 const done=await h.terminal(created.id);
 assert.equal(done.status,'completed');assert.ok(done.artifact);assert.match(done.output,/虚构/);assert.match(done.output,/TEST-ONLY fact 31415/);assert.match(done.output,/local integration test/);assert.ok(done.sources.some(s=>s.id===memory.id));
 const artifact=await h.request(done.artifact.url);assert.equal(artifact.status,200);assert.equal(await artifact.text(),done.output);assert.match(artifact.headers.get('content-disposition'),/attachment/);
 await h.restart();const restored=await h.json('/api/tasks/'+created.id);assert.equal(restored.status,'completed');assert.equal(restored.output,done.output);assert.equal(await(await h.request(restored.artifact.url)).text(),done.output);
 assert.ok((await h.state()).audit.some(a=>a.taskId===created.id&&a.action==='task.completed'));
});

test('reminders fire once, deduplicate across restart, and catch up after downtime',async t=>{
 const h=await harness(t);const reminder=await h.post('/api/reminders',{title:'Fabricated due reminder',dueAt:new Date(Date.now()-1000).toISOString()},201);
 h.app.engine.tick();h.app.engine.tick();let state=await h.state();assert.equal(state.notifications.filter(n=>n.reminderId===reminder.id).length,1);assert.equal(state.reminders.find(r=>r.id===reminder.id).status,'fired');
 await h.restart();h.app.engine.tick();state=await h.state();assert.equal(state.notifications.filter(n=>n.reminderId===reminder.id).length,1);assert.equal(state.audit.filter(a=>a.action==='reminder.fired'&&a.detail===reminder.title).length,1);
 await h.post('/api/heartbeat',{enabled:false});const overdue=await h.post('/api/reminders',{title:'Fabricated downtime reminder',dueAt:new Date(Date.now()-1000).toISOString()},201);await h.restart();assert.equal((await h.state()).notifications.filter(n=>n.reminderId===overdue.id).length,0);await h.post('/api/heartbeat',{enabled:true});h.app.engine.tick();assert.equal((await h.state()).notifications.filter(n=>n.reminderId===overdue.id).length,1);
 const offline=await h.post('/api/reminders',{title:'Fabricated reminder due while server stopped',dueAt:new Date(Date.now()+100).toISOString()},201);await h.restart(150);assert.equal((await h.state()).notifications.filter(n=>n.reminderId===offline.id).length,1);await h.restart();assert.equal((await h.state()).notifications.filter(n=>n.reminderId===offline.id).length,1);
});

test('researcher is denied workspace writes without creating an artifact',async t=>{
 const h=await harness(t);const task=await h.task('整理测试工作报告',{agentId:'researcher'});const done=await h.terminal(task.id);assert.equal(done.status,'failed');assert.match(done.error,/workspace\.write/);assert.equal(done.artifact,null);assert.deepEqual(await readdir(join(h.dataDir,'artifacts')),[]);
});

test('operation budget prevents subsequent workspace writes',async t=>{
 const h=await harness(t);const task=await h.task('整理测试工作报告',{budget:1});const done=await h.terminal(task.id);assert.equal(done.status,'failed');assert.match(done.error,/预算/);assert.equal(done.budgetUsed,1);assert.equal(done.artifact,null);assert.deepEqual(await readdir(join(h.dataDir,'artifacts')),[]);
});

test('disabled and narrowed delegate permissions are enforced',async t=>{
 const h=await harness(t);const state=await h.state();const writer=state.agents.find(a=>a.id==='writer');await h.json('/api/agents/writer',{method:'PUT',body:{...writer,permissions:['knowledge.read']}});const task=await h.task('整理测试工作报告');const done=await h.terminal(task.id);assert.equal(done.status,'failed');assert.match(done.error,/子智能体未获 workspace\.write/);assert.equal(done.artifact,null);
 const researcher=state.agents.find(a=>a.id==='researcher');await h.json('/api/agents/researcher',{method:'PUT',body:{...researcher,enabled:false}});assert.equal((await h.request('/api/tasks',{method:'POST',body:{prompt:'测试',agentId:'researcher'}})).status,400);
});

test('task cancellation interrupts a pending step and prevents output writes',async t=>{
 const h=await harness(t,{stepDelay:200});const created=await h.task('整理测试工作报告');await until(async()=>{const v=await h.json('/api/tasks/'+created.id);return v.steps.some(s=>s.name==='生成工作区文稿'&&s.status==='running');});await h.post('/api/tasks/'+created.id+'/cancel');await until(()=>!h.app.engine.running.has(created.id));const done=await h.json('/api/tasks/'+created.id);assert.equal(done.status,'cancelled');assert.equal(done.artifact,null);assert.equal(done.budgetUsed,1);assert.deepEqual(await readdir(join(h.dataDir,'artifacts')),[]);
});

test('interrupted queued tasks remain failed after restart, with no implicit retry',async t=>{
 const h=await harness(t);const task=await h.task('整理测试工作报告');await h.restart();const done=await h.json('/api/tasks/'+task.id);assert.ok(['failed','cancelled'].includes(done.status));await wait(50);assert.equal((await h.json('/api/tasks/'+task.id)).status,done.status);assert.equal(done.artifact,null);
});

test('real Chromium OA read and approval writes exactly once even with duplicate concurrent approvals',async t=>{
 const h=await harness(t);const created=await h.task('打开浏览器读取模拟OA并新增巡查安排');const pending=await h.awaiting(created.id);assert.match(pending.output,/K18\+200/);assert.equal(pending.browserSession.records.length,0);assert.equal(pending.browserSession.writeLease,false);
 const screenshot=await h.request('/api/browser/'+pending.browserSessionId+'/screenshot');assert.equal(screenshot.status,200);const png=Buffer.from(await screenshot.arrayBuffer());assert.equal(png.subarray(1,4).toString(),'PNG');
 const page=await h.app.broker.page(pending.browserSessionId);const premature=await page.request.post(h.app.url+'/fixture/oa/submit?session='+pending.browserSessionId,{data:{title:pending.browserSession.plannedTitle},headers:{origin:h.app.url}});assert.equal(premature.status(),403);
 const approval=await approvalFor(h,created.id);const attempts=await Promise.all([1,2].map(()=>h.request('/api/approvals/'+approval.id,{method:'POST',body:{decision:'approve'}})));assert.deepEqual(attempts.map(r=>r.status).sort(),[200,400]);
 const done=await h.json('/api/tasks/'+created.id);assert.equal(done.status,'completed');assert.equal(done.browserSession.records.length,1);assert.equal(done.browserSession.records[0].author,'agent-approved');assert.equal(done.browserSession.writeLease,false);assert.equal((await h.request('/api/approvals/'+approval.id,{method:'POST',body:{decision:'approve'}})).status,400);
 await h.restart();const restored=await h.json('/api/tasks/'+created.id);assert.equal(restored.browserSession.records.length,1);assert.equal((await h.request('/api/approvals/'+approval.id,{method:'POST',body:{decision:'approve'}})).status,400);
});

test('rejection never saves OA records and closes its browser context',async t=>{
 const h=await harness(t);const task=await h.task('读取模拟OA并新增巡查安排');const pending=await h.awaiting(task.id);const approval=await approvalFor(h,task.id);const result=await h.post('/api/approvals/'+approval.id,{decision:'reject'});assert.equal(result.status,'rejected');assert.equal((await h.json('/api/tasks/'+task.id)).browserSession.records.length,0);assert.equal(h.app.broker.live.has(pending.browserSessionId),false);assert.equal((await h.request('/api/approvals/'+approval.id,{method:'POST',body:{decision:'approve'}})).status,400);
});

test('takeover blocks approval; resume re-observes manual changes before approved write',async t=>{
 const h=await harness(t);const task=await h.task('在模拟OA新增巡查安排');const pending=await h.awaiting(task.id);const id=pending.browserSessionId;const approval=await approvalFor(h,task.id);await h.post('/api/browser/'+id+'/takeover');assert.equal((await h.request('/api/approvals/'+approval.id,{method:'POST',body:{decision:'approve'}})).status,400);assert.equal((await approvalFor(h,task.id)).status,'pending');
 const manual=await h.post('/fixture/oa/submit?session='+id,{title:'Fabricated manual update for re-observation'});assert.equal(manual.author,'manual');await h.post('/api/browser/'+id+'/resume');const page=await h.app.broker.page(id);assert.match(await page.locator('#records').innerText(),/Fabricated manual update/);assert.ok((await h.state()).audit.some(a=>a.action==='browser.resume'&&a.taskId===task.id));await h.post('/api/approvals/'+approval.id,{decision:'approve'});const done=await h.json('/api/tasks/'+task.id);assert.equal(done.status,'completed');assert.equal(done.browserSession.records.filter(r=>r.author==='agent-approved').length,1);assert.equal(done.browserSession.records.length,2);
});

test('cancelling a waiting browser task invalidates approval without writes',async t=>{
 const h=await harness(t);const task=await h.task('模拟OA新增巡查安排');await h.awaiting(task.id);const approval=await approvalFor(h,task.id);await h.post('/api/tasks/'+task.id+'/cancel');assert.equal((await approvalFor(h,task.id)).status,'cancelled');assert.equal((await h.request('/api/approvals/'+approval.id,{method:'POST',body:{decision:'approve'}})).status,400);const done=await h.json('/api/tasks/'+task.id);assert.equal(done.status,'cancelled');assert.equal(done.browserSession.records.length,0);assert.equal(done.browserSession.writeLease,false);
});

test('cancellation during in-flight OA observation cannot revive task or create approval',async t=>{
 const h=await harness(t);const original=h.app.broker.read.bind(h.app.broker);let observed=false,release;const gate=new Promise(r=>release=r);h.app.broker.read=async id=>{const result=await original(id);observed=true;await gate;return result;};
 const created=await h.task('浏览器读取模拟OA并新增巡查安排');await until(async()=>{if(observed)return true;const v=await h.json('/api/tasks/'+created.id);if(v.status==='failed')throw new Error(v.error);return false;},{description:'OA observation gate'});try{await h.post('/api/tasks/'+created.id+'/cancel');}finally{release();}await until(()=>!h.app.engine.running.has(created.id));const done=await h.json('/api/tasks/'+created.id);assert.equal(done.status,'cancelled');assert.equal((await h.state()).approvals.filter(a=>a.taskId===created.id&&a.status==='pending').length,0);assert.equal(done.browserSession.records.length,0);
});

test('API key stays only in memory and never appears in state, audit, or persisted files',async t=>{
 const h=await harness(t);const token='FAKE_TEST_TOKEN_DO_NOT_USE_9b1f75';const saved=await h.post('/api/settings',{mode:'demo',endpoint:'https://api.openai.com/v1',model:'fabricated-test-model',apiKey:token,budget:8});assert.equal(saved.hasApiKey,true);assert.equal(saved.credentialStorage,'memory-only');assert.ok(!JSON.stringify(saved).includes(token));const state=await h.state();assert.equal(state.settings.hasApiKey,true);assert.ok(!JSON.stringify(state).includes(token));assert.ok(!JSON.stringify(h.app.store.db.prepare('SELECT * FROM records').all()).includes(token));
 for(const path of await files(h.dataDir))assert.ok(!(await readFile(path)).includes(Buffer.from(token)),`token leaked to ${path}`);
 await h.restart();const restarted=await h.state();assert.equal(restarted.settings.hasApiKey,false);assert.ok(!JSON.stringify(restarted).includes(token));for(const path of await files(h.dataDir))assert.ok(!(await readFile(path)).includes(Buffer.from(token)));
});

test('host, cross-origin, session and request validation reject unauthorized access',async t=>{
 const h=await harness(t);assert.equal((await h.request('/api/state',{auth:false})).status,401);assert.equal((await h.request('/fixture/oa?session=missing',{auth:false})).status,401);assert.equal((await rawRequest(h.app.url,{headers:{host:'attacker.example'}})).status,403);assert.equal((await h.request('/api/state',{headers:{origin:'https://attacker.example'}})).status,403);assert.equal((await h.request('/api/tasks',{method:'POST',headers:{origin:'https://attacker.example'},body:{prompt:'should not create'}})).status,403);assert.equal((await h.request('/api/tasks',{method:'POST',headers:{'content-type':'text/plain'},body:{prompt:'should not create'}})).status,400);
 const index=await h.request('/');assert.match(index.headers.get('set-cookie'),/HttpOnly/);assert.match(index.headers.get('set-cookie'),/SameSite=Strict/);assert.match(index.headers.get('content-security-policy'),/object-src 'none'/);assert.equal((await h.state()).tasks.length,0);
 await assert.rejects(()=>startServer({port:0,dataDir:h.dataDir,host:'0.0.0.0'}),/127\.0\.0\.1/);
});

test('mutating API requests require an exact Origin, including rejecting absent Origin',async t=>{
 const h=await harness(t);const response=await h.request('/api/tasks',{method:'POST',body:{prompt:'untrusted missing-origin request'},origin:false});assert.equal(response.status,403);assert.equal((await h.state()).tasks.length,0);
});

test('desktop token is additionally required when desktop transport is configured',async t=>{
 const h=await harness(t,{desktopToken:'test-only-desktop-token'});assert.equal((await h.request('/api/state')).status,401);assert.equal((await h.request('/api/state',{headers:{'x-highway-desktop-token':'test-only-desktop-token'}})).status,200);assert.equal((await h.request('/api/state',{headers:{'x-highway-desktop-token':'wrong'}})).status,401);
});

test('model endpoint policy requires HTTPS and blocks local/private destinations by default',async()=>{
 for(const url of ['http://127.0.0.1:9999/v1','http://example.com/v1','https://localhost/v1','https://test.local/v1','https://test.internal/v1','https://127.0.0.1/v1','https://10.0.0.1/v1','https://172.16.0.1/v1','https://192.168.1.1/v1','https://169.254.169.254/v1','https://100.64.0.1/v1','https://198.51.100.1/v1','https://203.0.113.1/v1','https://0.0.0.0/v1','https://[::1]/v1','https://user:password@example.com/v1','https://example.com:8443/v1','https://example.com/v1?key=secret','https://example.com/v1#fragment'])await assert.rejects(()=>validateEndpoint(url),{name:'Error'});
 assert.equal(await validateEndpoint('http://127.0.0.1:9999/v1',{allowTestLocal:true}),'http://127.0.0.1:9999/v1');await assert.rejects(()=>validateEndpoint('http://localhost:9999/v1',{allowTestLocal:true}));
});

test('model adapter exercises real local HTTP success, HTTP failures, malformed data and cancellation',async t=>{
 let responseMode='success',received=[];
 const server=http.createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;received.push({path:req.url,auth:req.headers.authorization,body:JSON.parse(body)});if(responseMode==='slow'){await wait(150);if(res.destroyed)return;}if(typeof responseMode==='number'){res.writeHead(responseMode);return res.end('FAKE_TEST_API_KEY_MUST_NOT_BE_ECHOED');}if(responseMode==='bad-json')return res.end('not JSON');if(responseMode==='missing')return res.end(JSON.stringify({choices:[]}));if(responseMode==='redirect'){res.writeHead(302,{location:'http://127.0.0.1:1/should-not-follow'});return res.end();}res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{content:'fabricated model result'}}],usage:{total_tokens:12}}));});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const args={endpoint:`http://127.0.0.1:${server.address().port}/v1`,model:'test-model',key:'FAKE_TEST_API_KEY_MUST_NOT_BE_ECHOED',messages:[{role:'user',content:'fabricated request'}],allowTestLocal:true};const result=await callModel(args);assert.equal(result.content,'fabricated model result');assert.equal(result.usage.total_tokens,12);assert.equal(received[0].path,'/v1/chat/completions');assert.equal(received[0].auth,'Bearer '+args.key);assert.equal(received[0].body.model,args.model);
 for(const status of [401,403,404,429,500]){responseMode=status;await assert.rejects(()=>callModel(args),e=>e.code==='MODEL_HTTP_'+status&&!e.message.includes(args.key));}
 for(const mode of ['bad-json','missing']){responseMode=mode;await assert.rejects(()=>callModel(args),e=>e.code==='MODEL_RESPONSE');}
 responseMode='redirect';await assert.rejects(()=>callModel(args),e=>e.code==='MODEL_NETWORK');
 responseMode='slow';const controller=new AbortController();const pending=callModel({...args,signal:controller.signal});setTimeout(()=>controller.abort(),30);await assert.rejects(()=>pending,e=>e.code==='CANCELLED');
 await assert.rejects(()=>callModel({...args,key:''}),e=>e.code==='KEY_MISSING');await assert.rejects(()=>callModel({...args,model:''}),e=>e.code==='MODEL_MISSING');await assert.rejects(()=>callModel({...args,allowTestLocal:false}),e=>e.code==='ENDPOINT_INVALID');
});


async function isolatedServer(t){
 const dataDir=await mkdtemp(join(tmpdir(),'luheng-input-test-'));
 const script=`import {startServer} from ${JSON.stringify(new URL('../server.mjs',import.meta.url).href)}; const app=await startServer({port:0,dataDir:${JSON.stringify(dataDir)},stepDelay:1}); console.log(app.url);process.on('SIGTERM',async()=>{await app.close();process.exit(0);});`;
 const child=spawn(process.execPath,['--input-type=module','-e',script],{stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
 t.after(async()=>{if(child.exitCode===null){const exited=new Promise(r=>child.once('exit',r));child.kill('SIGTERM');await exited;}await rm(dataDir,{recursive:true,force:true});});
 const url=await until(()=>{if(child.exitCode!==null)throw new Error(stderr);return stdout.includes('\n')&&stdout.trim().split('\n')[0];},{timeout:5000,description:'isolated server start'});
 return {child,url,get stderr(){return stderr;}};
}

test('malformed multibyte fixture token cannot terminate server process',async t=>{
 const h=await isolatedServer(t);const response=await rawRequest(h.url,{headers:{'x-fixture-token':'a'.repeat(63)+'é'}});assert.equal(response.status,200);assert.equal(h.child.exitCode,null,h.stderr);assert.equal((await rawRequest(h.url)).status,200);
});

test('malformed absolute request URL receives a rejection without terminating server',async t=>{
 const h=await isolatedServer(t);const response=await new Promise((resolve,reject)=>{const req=http.request(h.url,{path:'http://%',headers:{host:new URL(h.url).host}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.end();});assert.ok([400,403].includes(response),String(response));assert.equal(h.child.exitCode,null,h.stderr);assert.equal((await rawRequest(h.url)).status,200);
});

test('memory-only API key is bound to endpoint origin and clears on origin change',async t=>{
 const h=await harness(t);const keyA='FAKE_ORIGIN_A_TEST_TOKEN',keyB='FAKE_ORIGIN_B_TEST_TOKEN';const settings={mode:'demo',endpoint:'https://one.example.invalid/v1',model:'test-model',budget:12};
 let result=await h.post('/api/settings',{...settings,apiKey:keyA});assert.equal(result.hasApiKey,true);assert.equal(h.app.engine.getKey('https://one.example.invalid/v1'),keyA);assert.equal(h.app.engine.getKey('https://two.example.invalid/v1'),'');
 result=await h.post('/api/settings',{...settings,endpoint:'https://one.example.invalid/v2'});assert.equal(result.hasApiKey,true);assert.equal(h.app.engine.getKey('https://one.example.invalid/another'),keyA);
 result=await h.post('/api/settings',{...settings,endpoint:'https://two.example.invalid/v1'});assert.equal(result.hasApiKey,false);assert.equal(h.app.engine.getKey('https://one.example.invalid/v1'),'');assert.equal(h.app.engine.getKey('https://two.example.invalid/v1'),'');
 result=await h.post('/api/settings',{...settings,endpoint:'https://two.example.invalid/v1',apiKey:keyB});assert.equal(result.hasApiKey,true);assert.equal(h.app.engine.getKey('https://one.example.invalid/v1'),'');assert.equal(h.app.engine.getKey('https://two.example.invalid/v1'),keyB);
 await h.post('/api/settings',{...settings,endpoint:'https://two.example.invalid/v1',clearApiKey:true});assert.equal((await h.state()).settings.hasApiKey,false);
});

test('scheduler limits running tasks to two and drains the queue',async t=>{
 const h=await harness(t);const tasks=[];let maximum=0,release;
 const gate=new Promise(resolve=>{release=resolve;});const step=h.app.engine.step.bind(h.app.engine);
 // Hold actual running tasks until all requests are admitted. Polling a brief
 // running+queued moment after six HTTP round trips races on slower CI hosts.
 h.app.engine.step=async(...args)=>{maximum=Math.max(maximum,h.app.engine.running.size);await gate;return step(...args);};
 const sampler=setInterval(()=>maximum=Math.max(maximum,h.app.engine.running.size),1);
 try{
  for(let i=0;i<6;i++)tasks.push(await h.task('生成测试报告 '+i));
  await until(async()=>{const state=await h.state();return state.tasks.filter(task=>task.status==='running').length===2&&state.tasks.filter(task=>task.status==='queued').length===4;},{description:'two held running tasks and four queued tasks'});
  release();
  const results=await Promise.all(tasks.map(task=>h.terminal(task.id)));assert.ok(results.every(task=>task.status==='completed'));assert.equal(maximum,2);assert.equal(h.app.engine.running.size,0);
 }finally{release();clearInterval(sampler);}
});

test('at most thirty unfinished tasks are admitted and cancellation releases capacity',async t=>{
 const h=await harness(t,{stepDelay:10000});const tasks=[];for(let i=0;i<30;i++)tasks.push(await h.task('排队测试报告 '+i));
 const rejected=await h.request('/api/tasks',{method:'POST',body:{prompt:'over queue limit'}});assert.equal(rejected.status,400);assert.match((await rejected.json()).error,/30/);assert.ok(h.app.engine.running.size<=2);
 await h.post('/api/tasks/'+tasks.at(-1).id+'/cancel');const replacement=await h.task('replacement after cancel');assert.equal(replacement.status,'queued');const state=await h.state();assert.equal(state.tasks.filter(task=>!['completed','failed','cancelled','rejected'].includes(task.status)).length,30);
});
