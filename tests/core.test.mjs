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
const tc=(name,args,id)=>({id,type:'function',function:{name,arguments:JSON.stringify(args)}});
const toolResponse=(...calls)=>({message:{role:'assistant',content:null,tool_calls:calls}});
const textResponse=content=>({message:{role:'assistant',content}});
const noLocalPermissions=permissions=>permissions.filter(permission=>!['files.read','files.write','commands.run'].includes(permission));
async function narrowLocalRole(h,agentId='coordinator'){
 const actor=h.app.store.get('agents',agentId);
 await h.json('/api/agents/'+agentId,{method:'PUT',body:{...actor,permissions:noLocalPermissions(actor.permissions)}});
}
async function assertNoLegacyEffects(h){
 const state=await h.state();
 for(const kind of ['sessions','mail','mail_inbox','mail_outbox','mail_approvals','browser_approvals','controlled_sessions'])assert.deepEqual(h.app.store.all(kind),[],kind+' must remain empty');
 assert.deepEqual(state.approvals,[]);assert.deepEqual(await readdir(join(h.dataDir,'artifacts')),[]);
 assert.equal(state.system.capabilities.browserFixture,false);
}

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
 const h={get app(){return app;},dataDir,get cookie(){return cookie;},async request(path,{method='GET',body,headers={},origin=true,auth=true}={}){return fetch(app.url+path,{method,headers:{...(auth?{cookie}:{}),...(method!=='GET'?{'content-type':'application/json',...(origin?{origin:app.url}:{})}:{}),...headers},...(body!==undefined?{body:JSON.stringify(body)}:{})});},async json(path,options){const r=await h.request(path,options);const value=await r.json();assert.equal(r.status,options?.status??200,JSON.stringify(value));return value;},async post(path,body={},status=200){return h.json(path,{method:'POST',body,status});},async task(prompt,options={}){return h.post('/api/tasks',{prompt,...options},201);},async terminal(id){return until(async()=>{const v=await h.json('/api/tasks/'+id);return ['completed','cancelled','failed','rejected','needs_attention'].includes(v.status)&&!h.app.engine.running.has(id)&&v;},{description:'terminal task '+id});},async restart(delay=0){await app.close();if(delay)await wait(delay);app=await startServer({port:0,dataDir,stepDelay:1,...options});await login();},async state(){return h.json('/api/state');}};
 t.after(async()=>{await app.close();await rm(dataDir,{recursive:true,force:true});});
 return h;
}
function rawRequest(url,{path='/health',method='GET',headers={},body}={}){return new Promise((resolve,reject)=>{const req=http.request(new URL(path,url),{method,headers},res=>{let text='';res.setEncoding('utf8');res.on('data',s=>text+=s);res.on('end',()=>resolve({status:res.statusCode,text,headers:res.headers}));});req.on('error',reject);req.end(body);});}
async function files(dir){let result=[];for(const name of await readdir(dir)){const path=join(dir,name);if((await stat(path)).isDirectory())result.push(...await files(path));else result.push(path);}return result;}

test('fresh workspace is API-first and unconfigured tasks never fabricate reports, mail or OA',async t=>{
 const h=await harness(t);const state=await h.state();assert.equal(state.settings.mode,'api');assert.equal(state.settings.model,'');assert.equal(state.settings.hasApiKey,false);
 assert.deepEqual(state.memories,[]);assert.deepEqual(state.mail,[]);assert.deepEqual(state.realInbox,[]);assert.deepEqual(state.mailAccounts,[]);
 for(const prompt of ['整理本周养护工作简报，列出材料来源','读取演示邮件并起草回复','读取模拟OA并新增巡查安排']){
  const created=await h.task(prompt);const done=await h.terminal(created.id);assert.equal(done.mode,'api');assert.equal(done.status,'failed');assert.match(done.error,/API Key|模型名称/);assert.equal(done.output,'');assert.equal(done.artifact,null);
 }
 // A persisted pre-upgrade setting must not resurrect the deterministic demos.
 h.app.store.put('settings','main',{...h.app.store.get('settings','main'),mode:'demo'});
 const legacyCreated=await h.task('整理本周养护工作简报并提交模拟OA');const legacyDone=await h.terminal(legacyCreated.id);assert.equal(legacyDone.mode,'api');assert.equal(legacyDone.status,'failed');assert.match(legacyDone.error,/API Key|模型名称/);assert.equal(legacyDone.output,'');assert.equal(legacyDone.artifact,null);
 await assertNoLegacyEffects(h);
});

test('non-local model report, explicit source citations, artifact, knowledge and audit survive restart',async t=>{
 const report='Synthetic report: TEST-ONLY fact 31415. Source: local integration test.';let rounds=0;
 const h=await harness(t,{completion:async args=>{
  if(++rounds===1)return toolResponse(tc('knowledge_search',{query:'TEST-ONLY'},'knowledge-1'));
  if(rounds===2){const rows=JSON.parse(args.messages.at(-1).content).records;assert.equal(rows.length,1);assert.equal(rows[0].source,'local integration test');return toolResponse(tc('workspace_save',{name:'Synthetic report.txt',content:report},'save-1'));}
  assert.equal(JSON.parse(args.messages.at(-1).content).saved,true);return textResponse(report);
 }});
 await narrowLocalRole(h);
 const memory=await h.post('/api/memories',{title:'Fabricated test note',content:'TEST-ONLY fact 31415',source:'local integration test'},201);
 const created=await h.task('Summarize the TEST-ONLY note with its source and save the report');const done=await h.terminal(created.id);
 assert.equal(done.status,'completed',done.error);assert.equal(done.localContext,false);assert.equal(done.output,report);assert.ok(done.sources.some(s=>s.id===memory.id&&s.source===memory.source));assert.equal(rounds,3);
 const artifact=await h.request(done.artifact.url);assert.equal(artifact.status,200);assert.equal(await artifact.text(),report);assert.match(artifact.headers.get('content-disposition'),/attachment/);
 await h.restart();const restored=await h.json('/api/tasks/'+created.id);assert.equal(restored.status,'completed');assert.equal(restored.prompt,created.prompt);assert.equal(restored.output,report);assert.deepEqual(restored.sources,done.sources);assert.equal(await(await h.request(restored.artifact.url)).text(),report);assert.equal(rounds,3,'restart must not re-run completion');
 const stateAfterRestart=await h.state();assert.ok(stateAfterRestart.memories.some(m=>m.id===memory.id));assert.ok(stateAfterRestart.audit.some(a=>a.taskId===created.id&&a.action==='task.completed'));
});

test('default local-capable role keeps task text private while downloads survive restart',async t=>{
 const prompt='SYNTHETIC_PRIVATE_PROMPT_f7c251';const output='SYNTHETIC_PRIVATE_OUTPUT_923afa';let rounds=0;
 const h=await harness(t,{completion:async()=>++rounds===1?toolResponse(tc('workspace_save',{name:'SYNTHETIC_PRIVATE_FILENAME.txt',content:output},'private-save')):textResponse(output)});
 assert.equal((await h.state()).localAccess.mode,'disabled');const created=await h.task(prompt);const done=await h.terminal(created.id);
 assert.equal(done.status,'completed',done.error);assert.equal(done.localContext,true);assert.equal(done.liveResultAvailable,true);assert.equal(done.prompt,prompt);assert.equal(done.output,output);
 const stored=h.app.store.get('tasks',created.id);assert.deepEqual(stored.modelMessages,[]);assert.deepEqual(stored.toolQueue,[]);assert.equal(stored.sources,undefined);
 for(const value of [prompt,output,'SYNTHETIC_PRIVATE_FILENAME']){assert.equal(JSON.stringify(stored).includes(value),false);assert.equal(JSON.stringify((await h.state())).includes(value),false);assert.equal(JSON.stringify(h.app.store.db.prepare('SELECT * FROM records').all()).includes(value),false);}
 assert.equal(await(await h.request(done.artifact.url)).text(),output,'explicit delivery artifact remains downloadable');
 await h.restart();const restored=await h.json('/api/tasks/'+created.id);assert.equal(restored.status,'completed');assert.equal(restored.liveResultAvailable,false);assert.notEqual(restored.output,output);assert.notEqual(restored.prompt,prompt);assert.equal(await(await h.request(restored.artifact.url)).text(),output);assert.equal(rounds,2);
 const followup=await h.request('/api/tasks',{method:'POST',body:{prompt:'continue',previousTaskId:created.id}});assert.equal(followup.status,400);assert.match((await followup.json()).error,/重启清除/);
});

test('reminders fire once, deduplicate across restart, and catch up after downtime',async t=>{
 const h=await harness(t);const reminder=await h.post('/api/reminders',{title:'Fabricated due reminder',dueAt:new Date(Date.now()-1000).toISOString()},201);
 h.app.engine.tick();h.app.engine.tick();let state=await h.state();assert.equal(state.notifications.filter(n=>n.reminderId===reminder.id).length,1);assert.equal(state.reminders.find(r=>r.id===reminder.id).status,'fired');
 await h.restart();h.app.engine.tick();state=await h.state();assert.equal(state.notifications.filter(n=>n.reminderId===reminder.id).length,1);assert.equal(state.audit.filter(a=>a.action==='reminder.fired'&&a.detail===reminder.title).length,1);
 await h.post('/api/heartbeat',{enabled:false});const overdue=await h.post('/api/reminders',{title:'Fabricated downtime reminder',dueAt:new Date(Date.now()-1000).toISOString()},201);await h.restart();assert.equal((await h.state()).notifications.filter(n=>n.reminderId===overdue.id).length,0);await h.post('/api/heartbeat',{enabled:true});h.app.engine.tick();assert.equal((await h.state()).notifications.filter(n=>n.reminderId===overdue.id).length,1);
 const offline=await h.post('/api/reminders',{title:'Fabricated reminder due while server stopped',dueAt:new Date(Date.now()+100).toISOString()},201);await h.restart(150);assert.equal((await h.state()).notifications.filter(n=>n.reminderId===offline.id).length,1);await h.restart();assert.equal((await h.state()).notifications.filter(n=>n.reminderId===offline.id).length,1);
});

test('researcher is denied model-requested workspace writes without creating an artifact',async t=>{
 const h=await harness(t,{completion:async args=>{assert.equal(args.tools.some(tool=>tool.function.name==='workspace_save'),false);return toolResponse(tc('workspace_save',{name:'Denied report.txt',content:'Synthetic denied write'},'denied-write'));}});
 const task=await h.task('Save a synthetic test report',{agentId:'researcher'});const done=await h.terminal(task.id);assert.equal(done.status,'failed');assert.match(done.error,/workspace\.write/);assert.equal(done.artifact,null);assert.deepEqual(await readdir(join(h.dataDir,'artifacts')),[]);
});

test('operation budget counts the model request and prevents its subsequent workspace write',async t=>{
 let calls=0;const h=await harness(t,{completion:async()=>{calls++;return toolResponse(tc('workspace_save',{name:'Budget report.txt',content:'Synthetic budget write'},'budget-write'));}});
 const task=await h.task('Save a synthetic test report',{budget:1});const done=await h.terminal(task.id);assert.equal(done.status,'failed');assert.match(done.error,/预算/);assert.equal(done.budgetUsed,1);assert.equal(calls,1);assert.equal(done.artifact,null);assert.deepEqual(await readdir(join(h.dataDir,'artifacts')),[]);
});

test('disabled delegates and narrowed knowledge permission intersections are enforced',async t=>{
 let childCalls=0;const h=await harness(t,{completion:async args=>{if(args.messages[0].content.includes('受限只读子智能体')){childCalls++;return textResponse('must not run');}return toolResponse(tc('agent_delegate',{agentId:'writer',instruction:'Verify only the synthetic shared note'},'delegate-denied'));}});
 const state=await h.state();const writer=state.agents.find(a=>a.id==='writer');await h.json('/api/agents/writer',{method:'PUT',body:{...writer,permissions:['workspace.write']}});
 const task=await h.task('Delegate synthetic shared research to writer');const done=await h.terminal(task.id);assert.equal(done.status,'failed');assert.match(done.error,/共同获 knowledge\.read/);assert.equal(childCalls,0);assert.equal(done.artifact,null);
 const researcher=state.agents.find(a=>a.id==='researcher');await h.json('/api/agents/researcher',{method:'PUT',body:{...researcher,enabled:false}});assert.equal((await h.request('/api/tasks',{method:'POST',body:{prompt:'test',agentId:'researcher'}})).status,400);
 await h.json('/api/agents/writer',{method:'PUT',body:{...writer,enabled:false}});const disabledTask=await h.task('Delegate to the now disabled writer');const disabledDone=await h.terminal(disabledTask.id);assert.equal(disabledDone.status,'failed');assert.match(disabledDone.error,/可委派角色|停用|knowledge\.read/);assert.equal(childCalls,0);
});

test('task cancellation interrupts a pending model-chosen workspace step and prevents output writes',async t=>{
 let calls=0;const h=await harness(t,{stepDelay:200,completion:async()=>{calls++;return toolResponse(tc('workspace_save',{name:'Cancelled report.txt',content:'Synthetic cancelled write'},'cancel-write'));}});
 const created=await h.task('Save a synthetic test report');await until(async()=>{const v=await h.json('/api/tasks/'+created.id);return v.steps.some(s=>s.name==='工具 · workspace_save'&&s.status==='running');});await h.post('/api/tasks/'+created.id+'/cancel');await until(()=>!h.app.engine.running.has(created.id));const done=await h.json('/api/tasks/'+created.id);assert.equal(done.status,'cancelled');assert.equal(done.artifact,null);assert.equal(done.budgetUsed,1);assert.equal(calls,1);assert.deepEqual(await readdir(join(h.dataDir,'artifacts')),[]);
});

test('interrupted queued non-local tasks remain failed after restart without implicit model retry',async t=>{
 let calls=0;const h=await harness(t,{completion:async()=>{calls++;return textResponse('Synthetic result that must not be produced');}});await narrowLocalRole(h);h.app.engine.pump=()=>{};
 const task=await h.task('Synthetic queued task');await h.restart();const done=await h.json('/api/tasks/'+task.id);assert.equal(done.status,'failed');assert.match(done.error,/中断/);await wait(50);assert.equal((await h.json('/api/tasks/'+task.id)).status,'failed');assert.equal(done.artifact,null);assert.equal(calls,0);
});

for(const [name,args] of [['browser_read',{}],['browser_submit',{title:'Synthetic obsolete OA write'}],['mail_draft',{to:'synthetic@example.invalid',subject:'Synthetic obsolete draft',body:'Synthetic content'}]]){
 test('unsupported legacy '+name+' is not offered and fails closed without fake state',async t=>{
  let calls=0;const h=await harness(t,{completion:async request=>{calls++;assert.equal(request.tools.some(tool=>tool.function.name===name),false);return toolResponse(tc(name,args,'legacy-'+name));}});
  const capabilities=await h.json('/api/tools/capabilities');const capability=capabilities.tools.find(tool=>tool.name===name);assert.equal(capability.status,'unimplemented');assert.equal(capability.implementation.implemented,false);
  const created=await h.task('Synthetic request for removed capability '+name);const done=await h.terminal(created.id);assert.equal(done.status,'failed');assert.match(done.error,/尚无可调用实现/);assert.equal(calls,1);assert.equal(done.browserSessionId,undefined);assert.equal(done.artifact,null);await assertNoLegacyEffects(h);
  await h.restart();assert.equal((await h.json('/api/tasks/'+created.id)).status,'failed');assert.equal(calls,1,'restart must not replay unsupported calls');await assertNoLegacyEffects(h);
 });
}

test('removed fixture and legacy browser routes cannot create manual writes, takeover or screenshots',async t=>{
 const h=await harness(t);
 for(const auth of [true,false])for(const path of ['/fixture/oa?session=synthetic','/fixture/oa/submit?session=synthetic']){const response=await h.request(path,{auth,...(path.includes('/submit')?{method:'POST',body:{title:'Synthetic denied manual write'}}:{})});assert.equal(response.status,404);assert.match((await response.json()).error,/已移除/);}
 for(const [path,method] of [['/api/browser/synthetic/screenshot','GET'],['/api/browser/synthetic/takeover','POST'],['/api/browser/synthetic/resume','POST']]){const response=await h.request(path,{method,...(method==='POST'?{body:{}}:{})});assert.equal(response.status,410);assert.match((await response.json()).error,/已移除/);assert.equal((await h.request(path,{method,auth:false,...(method==='POST'?{body:{}}:{})})).status,401);}
 await assertNoLegacyEffects(h);
});

test('historical mock OA approvals cannot approve, reject, duplicate or replay after restart',async t=>{
 let writes=0;const h=await harness(t);h.app.broker.write=async()=>{writes++;throw new Error('must not reach removed broker');};
 const session={id:'synthetic-historical-session',taskId:'synthetic-historical-task',records:[],writeLease:false,status:'agent'};
 h.app.store.put('sessions',session.id,session);h.app.store.put('tasks',session.taskId,{id:session.taskId,agentId:'coordinator',mode:'demo',status:'awaiting_approval',browserSessionId:session.id,steps:[],artifact:null});
 const approval={id:'synthetic-historical-approval',taskId:session.taskId,sessionId:session.id,type:'browser.submit',status:'pending'};h.app.store.put('approvals',approval.id,approval);
 const attempts=await Promise.all(['approve','approve','reject'].map(decision=>h.request('/api/approvals/'+approval.id,{method:'POST',body:{decision}})));assert.deepEqual(attempts.map(response=>response.status),[400,400,400]);for(const response of attempts)assert.match((await response.json()).error,/旧版演示审批已移除/);
 assert.equal(writes,0);assert.equal(h.app.store.get('approvals',approval.id).status,'pending','removed approval cannot become approved');assert.deepEqual(h.app.store.get('sessions',session.id).records,[]);assert.equal(h.app.store.get('sessions',session.id).writeLease,false);
 await h.restart();h.app.broker.write=async()=>{writes++;};const replay=await h.request('/api/approvals/'+approval.id,{method:'POST',body:{decision:'approve'}});assert.equal(replay.status,400);assert.match((await replay.json()).error,/不会执行或重放/);assert.equal(writes,0);assert.deepEqual(h.app.store.get('sessions',session.id).records,[]);assert.deepEqual(await readdir(join(h.dataDir,'artifacts')),[]);
});

test('cancelling historical waiting mock OA task invalidates its approval without writes',async t=>{
 const h=await harness(t);let writes=0;h.app.broker.write=async()=>{writes++;};const taskId='synthetic-old-cancel-task',sessionId='synthetic-old-cancel-session',approvalId='synthetic-old-cancel-approval';
 h.app.store.put('sessions',sessionId,{id:sessionId,taskId,records:[],writeLease:false});h.app.store.put('tasks',taskId,{id:taskId,agentId:'coordinator',mode:'demo',status:'awaiting_approval',browserSessionId:sessionId,steps:[],artifact:null});h.app.store.put('approvals',approvalId,{id:approvalId,taskId,sessionId,type:'browser.submit',status:'pending'});
 const cancelled=await h.post('/api/tasks/'+taskId+'/cancel');assert.equal(cancelled.status,'cancelled');assert.equal(h.app.store.get('approvals',approvalId).status,'cancelled');assert.equal((await h.request('/api/approvals/'+approvalId,{method:'POST',body:{decision:'approve'}})).status,400);assert.equal(writes,0);assert.deepEqual(h.app.store.get('sessions',sessionId).records,[]);assert.equal(h.app.store.get('sessions',sessionId).writeLease,false);
 await h.restart();assert.equal((await h.json('/api/tasks/'+taskId)).status,'cancelled');assert.equal(h.app.store.get('approvals',approvalId).status,'cancelled');assert.deepEqual(h.app.store.get('sessions',sessionId).records,[]);
});

test('cancellation during an in-flight model response cannot revive a task or create legacy approval',async t=>{
 let entered=false,release;const gate=new Promise(resolve=>release=resolve);const h=await harness(t,{completion:async()=>{entered=true;await gate;return toolResponse(tc('browser_submit',{title:'Synthetic obsolete write'},'late-legacy-write'));}});
 const created=await h.task('Synthetic obsolete browser request');await until(()=>entered,{description:'model completion gate'});try{await h.post('/api/tasks/'+created.id+'/cancel');}finally{release();}await until(()=>!h.app.engine.running.has(created.id));const done=await h.json('/api/tasks/'+created.id);assert.equal(done.status,'cancelled');assert.equal(done.artifact,null);await assertNoLegacyEffects(h);
});

test('API key stays only in memory and never appears in state, audit, or persisted files',async t=>{
 const h=await harness(t);const token='FAKE_TEST_TOKEN_DO_NOT_USE_9b1f75';const saved=await h.post('/api/settings',{mode:'demo',endpoint:'https://api.openai.com/v1',model:'fabricated-test-model',apiKey:token,budget:8});assert.equal(saved.hasApiKey,true);assert.equal(saved.credentialStorage,'memory-only');assert.ok(!JSON.stringify(saved).includes(token));const state=await h.state();assert.equal(state.settings.hasApiKey,true);assert.ok(!JSON.stringify(state).includes(token));assert.ok(!JSON.stringify(h.app.store.db.prepare('SELECT * FROM records').all()).includes(token));
 for(const path of await files(h.dataDir))assert.ok(!(await readFile(path)).includes(Buffer.from(token)),`token leaked to ${path}`);
 await h.restart();const restarted=await h.state();assert.equal(restarted.settings.hasApiKey,false);assert.ok(!JSON.stringify(restarted).includes(token));for(const path of await files(h.dataDir))assert.ok(!(await readFile(path)).includes(Buffer.from(token)));
});

test('host, cross-origin, session and request validation reject unauthorized access',async t=>{
 const h=await harness(t);assert.equal((await h.request('/api/state',{auth:false})).status,401);assert.equal((await h.request('/api/browser/missing/screenshot',{auth:false})).status,401);assert.equal((await rawRequest(h.app.url,{headers:{host:'attacker.example'}})).status,403);assert.equal((await h.request('/api/state',{headers:{origin:'https://attacker.example'}})).status,403);assert.equal((await h.request('/api/tasks',{method:'POST',headers:{origin:'https://attacker.example'},body:{prompt:'should not create'}})).status,403);assert.equal((await h.request('/api/tasks',{method:'POST',headers:{'content-type':'text/plain'},body:{prompt:'should not create'}})).status,400);
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

test('malformed obsolete fixture token header cannot grant access or terminate server process',async t=>{
 const h=await isolatedServer(t);const response=await rawRequest(h.url,{headers:{'x-fixture-token':'a'.repeat(63)+'é'}});assert.equal(response.status,200);assert.equal(h.child.exitCode,null,h.stderr);assert.equal((await rawRequest(h.url,{path:'/fixture/oa?session=synthetic',headers:{'x-fixture-token':'a'.repeat(63)+'é'}})).status,404);assert.equal((await rawRequest(h.url)).status,200);
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
 let completions=0;const h=await harness(t,{completion:async()=>{completions++;return textResponse('Synthetic queue result');}});const tasks=[];let maximum=0,release;
 const gate=new Promise(resolve=>{release=resolve;});const step=h.app.engine.step.bind(h.app.engine);
 // Hold actual running tasks until all requests are admitted. Polling a brief
 // running+queued moment after six HTTP round trips races on slower CI hosts.
 h.app.engine.step=async(...args)=>{maximum=Math.max(maximum,h.app.engine.running.size);await gate;return step(...args);};
 const sampler=setInterval(()=>maximum=Math.max(maximum,h.app.engine.running.size),1);
 try{
  for(let i=0;i<6;i++)tasks.push(await h.task('生成测试报告 '+i));
  await until(async()=>{const state=await h.state();return state.tasks.filter(task=>task.status==='running').length===2&&state.tasks.filter(task=>task.status==='queued').length===4;},{description:'two held running tasks and four queued tasks'});
  release();
  const results=await Promise.all(tasks.map(task=>h.terminal(task.id)));assert.ok(results.every(task=>task.status==='completed'));assert.equal(maximum,2);assert.equal(h.app.engine.running.size,0);assert.equal(completions,6);
 }finally{release();clearInterval(sampler);}
});

test('at most thirty unfinished tasks are admitted and cancellation releases capacity',async t=>{
 const h=await harness(t,{stepDelay:10000});const tasks=[];for(let i=0;i<30;i++)tasks.push(await h.task('排队测试报告 '+i));
 const rejected=await h.request('/api/tasks',{method:'POST',body:{prompt:'over queue limit'}});assert.equal(rejected.status,400);assert.match((await rejected.json()).error,/30/);assert.ok(h.app.engine.running.size<=2);
 await h.post('/api/tasks/'+tasks.at(-1).id+'/cancel');const replacement=await h.task('replacement after cancel');assert.equal(replacement.status,'queued');const state=await h.state();assert.equal(state.tasks.filter(task=>!['completed','failed','cancelled','rejected'].includes(task.status)).length,30);
});
