import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createProtocol,startMockProvider,MODEL,DUMMY_KEY,CAPABILITY_PROBES} from './mock-provider.mjs';
import {main as nativeMain,inspectMockDom,EXPECTED_INSTALLER_SHA,waitForInstalledTarget,rendererEvaluationValue,clickWhenUnobscured} from './probe-mock-chat.mjs';
import {verifyReceipt} from './verify-mock-evidence.mjs';

const fixture={markerPath:'C:\\synthetic-disposable\\owned-marker.txt',markerText:'LUHENG_READ_MARKER_'+'a'.repeat(32),nonce:'b'.repeat(32)};
const schema={type:'function',function:{name:'read_file',parameters:{type:'object',properties:{path:{type:'string'},offset:{type:'integer'},limit:{type:'integer'}},required:['path']}}};
function first(p,stream=false){return {model:MODEL,stream,messages:[{role:'system',content:'Synthetic test instructions'},{role:'user',content:p.prompt}],tools:[schema]};}
function follow(p,answer,stream=false){return {...first(p,stream),messages:[...first(p).messages,{role:'assistant',content:null,tool_calls:[{id:answer.callId,type:'function',function:{name:'read_file',arguments:JSON.stringify(answer.args)}}]},{role:'tool',tool_call_id:answer.callId,name:'read_file',content:'1|'+fixture.markerText+'\n'}]};}

test('deterministic exact read_file protocol requires marker before final',()=>{
  const p=createProtocol(fixture),a=p.completion(first(p));assert.equal(a.kind,'tool');
  assert.deepEqual(a.args,{path:fixture.markerPath,offset:1,limit:5});
  const b=p.completion(follow(p,a));assert.equal(b.kind,'final');assert.equal(b.content,p.finalText);
  assert.equal(p.state.marker_verified,true);assert.equal(p.state.model_requests,2);
  assert.throws(()=>p.completion(follow(p,a)),/extra_model/);
});
test('rejects any different user turn without persisting prompt text',()=>{
  const p=createProtocol(fixture),body=first(p);body.messages[1].content='UNEXPECTED_PRIVATE_SENTINEL';
  assert.throws(()=>p.completion(body),/unexpected_user/);assert.ok(!JSON.stringify(p.state).includes('UNEXPECTED_PRIVATE_SENTINEL'));
});
test('rejects missing read_file schema, wrong tool, altered path, marker leak and missing marker',()=>{
  let p=createProtocol(fixture),body=first(p);body.tools=[];assert.throws(()=>p.completion(body),/schema_missing/);
  for(const mutation of [
    b=>{b.messages.at(-2).tool_calls[0].function.name='terminal';},
    b=>{b.messages.at(-2).tool_calls[0].function.arguments=JSON.stringify({path:'C:\\not-owned',offset:1,limit:5});},
    b=>{b.messages[0].content=fixture.markerText;},
    b=>{b.messages.at(-1).content='File not found';},
    b=>{b.messages.at(-1).tool_call_id='wrong';},
  ]){p=createProtocol(fixture);const a=p.completion(first(p));body=follow(p,a);mutation(body);assert.throws(()=>p.completion(body));assert.equal(p.state.marker_verified,false);}
});
test('allows only bounded source-grounded one-token transport probe',()=>{
  const p=createProtocol(fixture),probe={model:MODEL,max_tokens:1,messages:[{role:'user',content:'hi'}]};
  assert.equal(p.completion(probe).kind,'probe');assert.equal(p.completion(probe).kind,'probe');assert.throws(()=>p.completion(probe));
});
test('builtin HTTP nonstream roundtrip with owned real filesystem marker',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'luheng-mock-selftest-'));
  const markerPath=path.join(root,'owned-marker.txt');fs.writeFileSync(markerPath,fixture.markerText+'\n');
  const p=await startMockProvider({...fixture,markerPath});
  try{
    const headers={'Authorization':`Bearer ${DUMMY_KEY}`,'Content-Type':'application/json'};
    const models=await fetch(p.baseUrl+'/models',{headers});assert.equal(models.status,200);assert.equal((await models.json()).data[0].id,MODEL);
    const ask=body=>fetch(p.baseUrl+'/chat/completions',{method:'POST',headers,body:JSON.stringify(body)});
    const r1=await ask(first(p));assert.equal(r1.status,200);const a=(await r1.json()).choices[0].message;
    assert.equal(a.tool_calls[0].function.name,'read_file');
    const args=JSON.parse(a.tool_calls[0].function.arguments);assert.equal(args.path,markerPath);
    // Harness-only fixture read; this selftest is explicitly not native app execution.
    const read=fs.readFileSync(args.path,'utf8');
    const body={...first(p),messages:[...first(p).messages,a,{role:'tool',tool_call_id:a.tool_calls[0].id,content:'1|'+read}]};
    const r2=await ask(body);assert.equal(r2.status,200);assert.equal((await r2.json()).choices[0].message.content,p.finalText);
    assert.equal(p.state.stage,2);assert.equal(p.state.marker_verified,true);
    assert.equal(p.state.rejected_requests,0);assert.ok(!JSON.stringify(p.state).includes(p.prompt));assert.ok(!JSON.stringify(p.state).includes(DUMMY_KEY));
  }finally{await p.close();fs.rmSync(root,{recursive:true});}
});
test('builtin HTTP SSE chunks reconstruct tool arguments and final response',async()=>{
  const p=await startMockProvider(fixture);
  try{
    const ask=async body=>{
      const r=await fetch(p.baseUrl+'/chat/completions',{method:'POST',headers:{Authorization:`Bearer ${DUMMY_KEY}`,'Content-Type':'application/json'},body:JSON.stringify(body)});
      assert.equal(r.status,200);assert.match(r.headers.get('content-type'),/event-stream/);
      const text=await r.text();assert.ok(text.endsWith('data: [DONE]\n\n'));
      return text.split('\n\n').filter(x=>x.startsWith('data: {')).map(x=>JSON.parse(x.slice(6)));
    };
    const chunks=await ask(first(p,true));
    const deltas=chunks.flatMap(c=>c.choices).map(c=>c.delta),parts=deltas.flatMap(d=>d.tool_calls||[]);
    const a={kind:'tool',callId:parts[0].id,args:JSON.parse(parts.map(x=>x.function.arguments).join(''))};
    assert.equal(parts[0].function.name,'read_file');assert.deepEqual(a.args,{path:fixture.markerPath,offset:1,limit:5});
    const final=await ask(follow(p,a,true));
    assert.equal(final.flatMap(c=>c.choices).map(c=>c.delta.content||'').join(''),p.finalText);
    assert.equal(p.state.requests[0].streaming,true);assert.equal(p.state.requests[1].streaming,true);
  }finally{await p.close();}
});
test('HTTP server rejects unknown path, non-synthetic auth and wrong host',async()=>{
  for(const mode of ['path','auth','host']){
    const p=await startMockProvider(fixture);
    try{
      const status=await new Promise((resolve,reject)=>{
        const req=http.get(p.baseUrl+(mode==='path'?'/unknown':'/models'),{headers:{Authorization:mode==='auth'?'Bearer not-a-real-secret':`Bearer ${DUMMY_KEY}`,...(mode==='host'?{Host:'external.invalid'}:{})}},r=>{r.resume();r.on('end',()=>resolve(r.statusCode));});req.on('error',reject);
      });
      assert.equal(status,400,mode);assert.ok(p.state.failure);assert.ok(!JSON.stringify(p.state).includes('not-a-real-secret'));
    }finally{await p.close();}
  }
});
test('native acceptance refuses Linux and all non-disposable invocation',async()=>{
  if(process.platform!=='win32')await assert.rejects(()=>nativeMain([]),/Disposable hosted Windows runner required/);
  assert.equal(EXPECTED_INSTALLER_SHA.length,64);
});
test('DOM source observes real transcript and restricts to six declared native input actions',()=>{
  const s=inspectMockDom.toString();assert.match(s,/data-role="assistant"/);assert.match(s,/data-role="user"/);
  for(const prohibited of ['innerHTML =','textContent =','localStorage.setItem','$messages.set','fetch(','window.hermesDesktop'])assert.ok(!s.includes(prohibited));
  assert.match(s,/Unapproved UI action/);assert.match(s,/Action target obscured/);
});
test('DOM observer fails closed when no settled installed UI targets exist',()=>{
  const previous=globalThis.document;globalThis.document={querySelectorAll:()=>[]};
  try{
    const observed=inspectMockDom(null,{baseUrl:'http://127.0.0.1:1/v1',dummyKey:DUMMY_KEY,prompt:'test',finalText:'test'});
    assert.equal(observed.assistant_reply_rendered,false);assert.equal(observed.user_prompt_rendered,false);
    assert.equal(observed.composer_count,0);assert.equal(observed.connect_enabled,false);
    assert.throws(()=>inspectMockDom('other',{}),/Unapproved UI action/);
    assert.throws(()=>inspectMockDom('send',{}),/Unexpected prompt state/);
    assert.throws(()=>inspectMockDom('local',{}),/Onboarding absent/);
  }finally{globalThis.document=previous;}
});
test('evidence verifier requires the real-roundtrip flags and keeps qualification limited',()=>{
  const p=createProtocol(fixture),a=p.completion(first(p));p.completion(follow(p,a));
  const receipt={schema:1,kind:'mocked-model-orchestration',installer_sha256:EXPECTED_INSTALLER_SHA,
    accepted_with_declared_limits:true,error:null,title_generation_disabled:true,synthetic_key_only:true,
    local_model_request_verified:true,real_read_file_roundtrip_verified:true,assistant_reply_rendered:true,marker_file_unchanged:true,
    real_provider_verified:false,llm_quality_verified:false,offline_verified:false,physical_ime_verified:false,os_network_settings_changed:false,
    provider_setup_route:'onboarding-local-endpoint-ui',loopback:{address:'127.0.0.1',ephemeral:true,closed:true,port:12345},
    direct_external_renderer_request_count:0,protocol:p.state,
    snapshots:[{stage:'mock-chat-tool-roundtrip.png',user_prompt_rendered:true,assistant_reply_rendered:true,stop_visible:false}],
    screenshots:[{path:'mock-provider-configured.png'},{path:'mock-chat-tool-roundtrip.png'}]};
  assert.equal(verifyReceipt(receipt),true);
  for(const mutation of [r=>r.real_provider_verified=true,r=>r.offline_verified=true,r=>r.protocol.stage=1,
    r=>r.protocol.model_requests=1,r=>r.protocol.marker_verified=false,r=>r.assistant_reply_rendered=false,
    r=>r.loopback.closed=false,r=>r.screenshots=[],r=>r.installer_sha256='0'.repeat(64)]){
    const bad=structuredClone(receipt);mutation(bad);assert.throws(()=>verifyReceipt(bad));
  }
});
test('same-socket installed renderer discovery retries zero matches but rejects ambiguity',async()=>{
  const helpers={allowedTarget:url=>url==='owned-file',chooseTarget:targets=>{const m=targets.filter(t=>t.url==='owned-file');if(m.length!==1)throw Error('Ambiguous installed renderer');return m[0];}};
  let n=0;const owned={type:'page',url:'owned-file',targetId:'owned'};
  const cdp={call:async method=>{assert.equal(method,'Target.getTargets');return {targetInfos:++n<3?[{type:'page',url:'about:blank'}]:[owned]};}};
  assert.equal((await waitForInstalledTarget(cdp,'root',helpers,100,1)).targetId,'owned');assert.equal(n,3);
  await assert.rejects(()=>waitForInstalledTarget({call:async()=>({targetInfos:[owned,owned]})},'root',helpers,100,1),/Ambiguous/);
  await assert.rejects(()=>waitForInstalledTarget({call:async()=>({targetInfos:[]})},'root',helpers,0,1),/Bounded timeout/);
});
test('anonymous discovery matches pinned picker; exact native capability probes return bounded 404',async()=>{
  const p=await startMockProvider(fixture);
  try{
    const catalog=await fetch(p.baseUrl+'/models');assert.equal(catalog.status,200);
    assert.equal((await catalog.json()).data[0].context_length,131072);
    for(const route of CAPABILITY_PROBES){for(const headers of [{},{Authorization:`Bearer ${DUMMY_KEY}`}]){
      const r=await fetch(`http://127.0.0.1:${p.port}${route}`,{headers});assert.equal(r.status,404);await r.text();
    }}
    assert.equal(p.state.failure,null);assert.equal(p.state.rejected_requests,0);
    assert.equal(p.state.anonymous_discovery_requests,1);assert.equal(p.state.capability_probe_requests,10);
    assert.equal(p.state.model_requests,0);assert.equal(p.state.stage,0);
    // Read-only discovery never substitutes for an authenticated real chat turn.
    const denied=await fetch(p.baseUrl+'/chat/completions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(first(p))});
    assert.equal(denied.status,400);assert.equal(p.state.stage,0);
    assert.deepEqual(p.state.failure_request,{method:'POST',route:'chat_completions',auth_kind:'missing'});
  }finally{await p.close();}
});
test('discovery exceptions do not permit foreign auth, other routes, query strings or mutation',async()=>{
  for(const {route,method,headers} of [
    {route:'/v1/models',method:'GET',headers:{Authorization:'Bearer FOREIGN_VALUE'}},
    {route:'/api/tags',method:'GET',headers:{Authorization:'Bearer FOREIGN_VALUE'}},
    {route:'/api/tags',method:'POST',headers:{}},
    {route:'/v1/models?secret=DO_NOT_LOG_THIS',method:'GET',headers:{}},
    {route:'/api/show',method:'POST',headers:{}},
  ]){
    const p=await startMockProvider(fixture);
    try{
      const r=await fetch(`http://127.0.0.1:${p.port}${route}`,{method,headers});assert.equal(r.status,400);assert.ok(p.state.failure);
      assert.ok(!JSON.stringify(p.state).includes('FOREIGN_VALUE'));assert.ok(!JSON.stringify(p.state).includes('DO_NOT_LOG_THIS'));
    }finally{await p.close();}
  }
});
test('source-grounded capability exception has a per-path request budget',async()=>{
  const p=await startMockProvider(fixture);
  try{
    for(let i=0;i<8;i++){const r=await fetch(`http://127.0.0.1:${p.port}/version`);assert.equal(r.status,404);await r.text();}
    const r=await fetch(`http://127.0.0.1:${p.port}/version`);assert.equal(r.status,400);
    assert.equal(p.state.failure,'capability_probe_path_limit');assert.equal(p.state.model_requests,0);
  }finally{await p.close();}
});

const rendererError=description=>({exceptionDetails:{text:'Uncaught',exception:{description}}});
test('renderer diagnostics retain only exact allowlisted harness errors, never external values or stacks',()=>{
  let caught;
  try{rendererEvaluationValue(rendererError('Error: Action target obscured\n    at SECRET_STACK_PATH'));}catch(e){caught=e;}
  assert.equal(caught.code,'action_target_obscured');
  assert.equal(caught.message,'Installed renderer harness: Action target obscured');
  assert.ok(!caught.message.includes('SECRET_STACK_PATH'));
  for(const raw of ['Error: SECRET_API_KEY_VALUE','Error: Action target obscured SECRET_API_KEY_VALUE','TypeError: Action target obscured']){
    assert.throws(()=>rendererEvaluationValue(rendererError(raw)),e=>e.message==='Installed renderer observation/action failed'&&!e.code);
  }
  assert.throws(()=>rendererEvaluationValue({}),/Installed renderer observation\/action failed/);
  assert.equal(rendererEvaluationValue({result:{value:false}}),false);
});

test('real Send hit test waits out covering toast and dispatches exactly one mouse pair',async()=>{
  const names=['document','getComputedStyle','innerWidth','innerHeight'];
  const saved=new Map(names.map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]));
  let toast=true,clock=0,observations=0;const dispatched=[];
  const send={textContent:'Send',disabled:false,getClientRects:()=>[{}],querySelectorAll:()=>[],
    getAttribute:()=> 'Send',scrollIntoView(){},getBoundingClientRect:()=>({x:100,y:100,width:40,height:30}),
    contains:e=>e===send};
  const composer={innerText:'synthetic prompt',getClientRects:()=>[{}]};
  const overlay={};
  globalThis.getComputedStyle=()=>({visibility:'visible',opacity:'1'});
  globalThis.innerWidth=800;globalThis.innerHeight=600;
  globalThis.document={
    querySelectorAll:selector=>{
      if(selector==='button'||selector==='button[type="submit"]')return [send];
      if(selector==='[data-slot="composer-rich-input"][contenteditable="true"]')return [composer];
      return [];
    },
    elementFromPoint:()=>toast?overlay:send,
  };
  const expected={prompt:'synthetic prompt',finalText:'final',baseUrl:'http://127.0.0.1:1/v1',dummyKey:DUMMY_KEY};
  const inspect=async action=>{
    observations++;
    try{return rendererEvaluationValue({result:{value:inspectMockDom(action,expected)}});}
    catch(e){if(e.code)throw e;return rendererEvaluationValue(rendererError('Error: '+e.message));}
  };
  try{
    const receipt=await clickWhenUnobscured(inspect,async params=>{
      assert.equal(toast,false,'No input through the toast');dispatched.push(params);
    },'send',{timeoutMs:1000,intervalMs:100,now:()=>clock,delay:async ms=>{
      assert.equal(dispatched.length,0,'No input while waiting');clock+=ms;if(clock>=200)toast=false;
    }});
    assert.equal(observations,3);assert.equal(receipt.blocked_hit_tests,2);assert.equal(receipt.waited_ms,200);
    assert.deepEqual(dispatched.map(x=>x.type),['mousePressed','mouseReleased']);
    assert.ok(dispatched.every(x=>x.x===120&&x.y===115&&x.button==='left'&&x.clickCount===1));
  }finally{for(const [name,descriptor] of saved){if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globalThis[name];}}
});

test('permanently covered target times out without any mouse input',async()=>{
  let clock=0,observations=0;const dispatched=[];
  await assert.rejects(()=>clickWhenUnobscured(async()=>{
    observations++;return rendererEvaluationValue(rendererError('Error: Action target obscured'));
  },async p=>dispatched.push(p),'send',{
    timeoutMs:300,intervalMs:100,now:()=>clock,delay:async ms=>{clock+=ms;},
  }),/Bounded timeout: unobscured send action/);
  assert.equal(clock,300);assert.equal(observations,3);assert.deepEqual(dispatched,[]);
});

test('wrong state, ambiguous targets and unclassified renderer errors are never retried',async()=>{
  for(const message of ['Action target ambiguous or disabled','Unexpected prompt state','SECRET_UNEXPECTED_ERROR']){
    let calls=0,delays=0;const dispatched=[];
    await assert.rejects(()=>clickWhenUnobscured(async()=>{calls++;return rendererEvaluationValue(rendererError('Error: '+message));},
      async p=>dispatched.push(p),'send',{delay:async()=>{delays++;}}));
    assert.equal(calls,1);assert.equal(delays,0);assert.deepEqual(dispatched,[]);
  }
});

test('mouse dispatch failure is not retried and protocol failure prevents input',async()=>{
  for(const failOn of [1,2]){
    let inspections=0,dispatches=0;
    await assert.rejects(()=>clickWhenUnobscured(async()=>{inspections++;return {click:{x:1,y:2}};},
      async()=>{dispatches++;if(dispatches===failOn)throw Error('synthetic input failure');},'send'),/synthetic input failure/);
    assert.equal(inspections,1);assert.equal(dispatches,failOn);
  }
  await assert.rejects(()=>clickWhenUnobscured(async()=>{throw Error('Should not inspect');},
    async()=>{throw Error('Should not dispatch');},'send',{assertHealthy:()=>{throw Error('Mock rejected request: synthetic');}}),
    /Mock rejected request: synthetic/);
});


test('inspection crossing the action deadline cannot dispatch even when target becomes clear',async()=>{
  for(const obstructFirst of [false,true]){
    let clock=0,calls=0,dispatches=0;
    await assert.rejects(()=>clickWhenUnobscured(async()=>{
      calls++;
      if(obstructFirst&&calls===1)return rendererEvaluationValue(rendererError('Error: Action target obscured'));
      clock=301;return {click:{x:1,y:2}};
    },async()=>{dispatches++;},'send',{
      timeoutMs:300,intervalMs:100,now:()=>clock,delay:async ms=>{clock+=ms;},
    }),/Bounded timeout: unobscured send action/);
    assert.equal(dispatches,0);assert.equal(calls,obstructFirst?2:1);
  }
});
