import test from 'node:test';
import assert from 'node:assert/strict';
import { createControlledBrowserFixtures as fixtureSites } from './fixtures/controlled-sites.mjs';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { Store } from '../lib/store.mjs';
import { ControlledBrowserService, isPublicBrowserAddress } from '../lib/controlled-browser.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function setup(t,{sites=true,fixturesOptions={},...options}={}) {
  const dir=await mkdtemp(join(tmpdir(),'controlled-browser-test-'));const store=new Store(dir);
  const fixtures=sites?await fixtureSites(fixturesOptions):null;
  const service=new ControlledBrowserService(store,{dataDir:dir,allowTestLocal:!!fixtures,...options});
  t.after(async()=>{await service.close();if(fixtures)await fixtures.close();store.close();await rm(dir,{recursive:true,force:true});});
  if(fixtures)await service.configureTargets([{id:'oa',name:'虚构OA',startUrl:fixtures.oa.origin+'/oa'},{id:'ticket',name:'虚构工单',startUrl:fixtures.ticket.origin+'/tickets/204'}]);
  return {dir,store,service,...fixtures};
}
const find = (observation,label) => {const c=observation.controls.find(c=>c.label===label);assert.ok(c,'Missing control '+label);return c;};
const actions = (observation,text) => [{type:'fill',controlId:find(observation,'巡查安排').controlId,value:text},{type:'click',controlId:find(observation,'保存安排').controlId}];
const proposal = (service,sessionId,observation,text='虚构：周五巡查') => service.proposeActions(sessionId,{observationId:observation.observationId,actions:actions(observation,text),reason:'仅对虚构本地站点执行测试'});

// These policy tests do not launch Chromium or connect to external sites.
test('controlled policy: public IP classification blocks reserved/private address families',()=>{
  for(const ip of ['127.0.0.1','10.0.0.1','169.254.169.254','100.64.0.1','192.168.1.1','192.0.2.1','198.18.0.1','203.0.113.1','224.0.0.1','255.255.255.255','::1','::ffff:127.0.0.1','fc00::1','fe80::1','2001:db8::1','2002:7f00:1::1','3fff::1']) assert.equal(isPublicBrowserAddress(ip),false,ip);
  for(const ip of ['8.8.8.8','1.1.1.1','2606:4700:4700::1111'])assert.equal(isPublicBrowserAddress(ip),true,ip);
});

test('controlled policy: production configuration rejects local URLs and DNS changes before launch',async t=>{
  let lookups=0;
  const {service}=await setup(t,{sites:false,resolveHost:async()=>[{address:++lookups===1?'93.184.216.34':'127.0.0.1',family:4}]});
  for(const url of ['http://127.0.0.1:4318','https://127.0.0.1','https://user:pass@example.com','https://example.com:444','https://example.com/?api_key=secret'])await assert.rejects(service.configureTargets([{id:'bad',startUrl:url}]));
  await service.configureTargets([{id:'public',startUrl:'https://approved.example.com/'}]);
  await assert.rejects(service.open('task','public'),error=>error.code==='TARGET_DNS_PRIVATE');
  assert.equal(lookups,2);
  assert.equal(service.live.size,0);
});

test('controlled browser: both distinct sites expose readable controls and approved actions work',async t=>{
  const {service,stats}=await setup(t);
  const a=await service.open('task-oa','oa');assert.match(a.observation.text,/桥面巡查/);assert.ok(a.observation.pageVersion);
  const password=find(a.observation,'账号密码');assert.equal(password.sensitive,true);assert.equal('value'in password,false);assert.equal(JSON.stringify(a.observation).includes('fixture-password-not-readable'),false);
  const p=await proposal(service,a.session.id,a.observation);
  assert.equal(stats.inputs,0);assert.equal(stats.saves,0);assert.equal(stats.unauthorizedWrites,0);
  await assert.rejects(service.decide(p.id,{decision:'approve',digest:'wrong'}),e=>e.code==='APPROVAL_DIGEST');
  const [one,two]=await Promise.all([service.decide(p.id,{decision:'approve',digest:p.digest}),service.decide(p.id,{decision:'approve',digest:p.digest})]);
  assert.equal(one.approval.status,'completed');assert.equal(two.approval.status,'completed');assert.equal(stats.saves,1,JSON.stringify(service.getSession(a.session.id)));assert.equal(stats.inputs,1);
  assert.equal((await service.decide(p.id,{decision:'approve',digest:p.digest})).approval.status,'completed');assert.equal(stats.saves,1);
  const b=await service.open('task-ticket','ticket');assert.match(b.observation.text,/T-204/);
  const q=await service.proposeActions(b.session.id,{observationId:b.observation.observationId,actions:[{type:'fill',controlId:find(b.observation,'处理说明').controlId,value:'虚构：已完成现场核实'},{type:'click',controlId:find(b.observation,'更新工单').controlId}],reason:'另一个DOM结构的虚构工单'});
  const updated=await service.decide(q.id,{decision:'approve',digest:q.digest});assert.equal(updated.approval.status,'completed');assert.match(updated.observation.text,/工单已更新 1/);assert.equal(stats.ticketSaves,1);
  const screenshot=await service.screenshot(b.session.id);assert.equal((await readFile(screenshot)).subarray(1,4).toString(),'PNG');
  assert.equal(stats.receivedProxyCredentials,false);
});

test('controlled browser: reject, sensitive fields and arbitrary selectors never emit input',async t=>{
  const {service,stats}=await setup(t);const {session,observation}=await service.open('task-reject','oa');
  const p=await proposal(service,session.id,observation);assert.equal((await service.decide(p.id,{decision:'reject',digest:p.digest})).approval.status,'rejected');
  await assert.rejects(service.proposeActions(session.id,{observationId:observation.observationId,actions:[{type:'fill',controlId:find(observation,'账号密码').controlId,value:'no-password-automation'}]}),e=>e.code==='SENSITIVE_CONTROL');
  await assert.rejects(service.proposeActions(session.id,{observationId:observation.observationId,actions:[{type:'click',selector:'#save',controlId:'c1'}]}),e=>e.code==='ACTION_UNSUPPORTED');
  assert.equal(stats.inputs,0);assert.equal(stats.saves,0);
});

test('controlled browser: human lease is exclusive, manual changes reobserved, stale approval cannot resume',async t=>{
  const {service,store,stats}=await setup(t);const {session,observation}=await service.open('task-manual','oa');
  const old=await proposal(service,session.id,observation,'旧提案不应执行');
  const manual=await service.takeover(session.id);assert.equal(manual.session.status,'manual');
  assert.equal((await service.decide(old.id,{decision:'approve',digest:old.digest})).blocked,'MANUAL_LEASE');
  await assert.rejects(service.takeover(session.id),e=>e.code==='MANUAL_LEASE');
  assert.equal(JSON.stringify(service.getPublicState()).includes(manual.leaseToken),false);
  assert.equal(JSON.stringify(store.all('controlled_sessions')).includes(manual.leaseToken),false);
  const input=await service.manualAction(session.id,{leaseToken:manual.leaseToken,observationId:manual.observation.observationId,action:{type:'fill',controlId:find(manual.observation,'巡查安排').controlId,value:'人工填入虚构安排'}});
  const saved=await service.manualAction(session.id,{leaseToken:manual.leaseToken,observationId:input.observation.observationId,action:{type:'click',controlId:find(input.observation,'保存安排').controlId}});
  assert.match(saved.observation.text,/人工填入虚构安排/);assert.equal(stats.saves,1);
  const resumed=await service.resume(session.id,{leaseToken:manual.leaseToken});assert.match(resumed.observation.text,/人工填入虚构安排/);
  assert.equal((await service.decide(old.id,{decision:'approve',digest:old.digest})).approval.status,'stale');assert.equal(stats.saves,1);
  await assert.rejects(service.manualAction(session.id,{leaseToken:manual.leaseToken,observationId:resumed.observation.observationId,action:{type:'click',controlId:find(resumed.observation,'保存安排').controlId}}),e=>e.code==='MANUAL_LEASE');
});

test('controlled browser: redirects, frames, fetch, websockets and service workers cannot escape whitelist',async t=>{
  const {service,stats,oa}=await setup(t);const {session}=await service.open('task-network','oa');await wait(200);
  const blocked=service.getSession(session.id).blockedRequests;
  assert.ok(blocked.some(x=>x.reason==='ORIGIN_BLOCKED'));assert.ok(blocked.some(x=>x.reason==='WEBSOCKET_BLOCKED'));
  assert.equal(stats.deniedHTTP,0);assert.equal(stats.deniedWS,0);assert.equal(stats.unauthorizedWrites,0);
  await service.configureTargets([{id:'escape',name:'跳转测试',startUrl:oa.origin+'/redirect'}]);
  await assert.rejects(service.open('task-escape','escape'));
  assert.equal(stats.deniedHTTP,0);assert.equal(service.live.size,0);
});

test('controlled browser: task sessions have separate cookies and localStorage',async t=>{
  const {service}=await setup(t);const first=await service.open('task-isolated-a','oa');
  const p=await proposal(service,first.session.id,first.observation,'private-session-A');
  const executed=await service.decide(p.id,{decision:'approve',digest:p.digest});assert.equal(executed.approval.status,'completed');assert.match(executed.observation.text,/owner=private-session-A/);
  const second=await service.open('task-isolated-b','oa');assert.match(second.observation.text,/存储：empty/);assert.match(second.observation.text,/会话：anonymous/);assert.equal(second.observation.text.includes('private-session-A'),false);
});

test('controlled browser: cancelled approvals emit no input and interrupted execution is never replayed',async t=>{
  const {service,store,stats}=await setup(t);const {session,observation}=await service.open('task-cancel','oa');
  const p=await proposal(service,session.id,observation);const abort=new AbortController();abort.abort();
  const cancelled=await service.decide(p.id,{decision:'approve',digest:p.digest,signal:abort.signal});assert.equal(cancelled.approval.status,'cancelled');assert.equal(stats.inputs,0);assert.equal(stats.saves,0);
  const observed=await service.read(session.id);const unknown=await proposal(service,session.id,observed);
  store.put('browser_approvals',unknown.id,{...unknown,status:'executing',inputStarted:true});
  await service.close();const restarted=new ControlledBrowserService(store,{allowTestLocal:true});t.after(()=>restarted.close());
  assert.equal((await restarted.decide(unknown.id,{decision:'approve',digest:unknown.digest})).approval.status,'unknown');assert.equal(stats.saves,0);
});


function pngRGBAt(png, targetX, targetY) {
  const width=png.readUInt32BE(16), depth=png[24], type=png[25];assert.equal(depth,8);assert.ok([2,6].includes(type));
  const channels=type===6?4:3, stride=width*channels;let offset=8;const chunks=[];
  while(offset<png.length){const length=png.readUInt32BE(offset),kind=png.toString('ascii',offset+4,offset+8);if(kind==='IDAT')chunks.push(png.subarray(offset+8,offset+8+length));offset+=12+length;}
  const raw=inflateSync(Buffer.concat(chunks));let previous=Buffer.alloc(stride),pos=0;
  const paeth=(a,b,c)=>{const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);return pa<=pb&&pa<=pc?a:pb<=pc?b:c;};
  for(let y=0;y<=targetY;y++){const filter=raw[pos++],row=Buffer.alloc(stride);for(let x=0;x<stride;x++){const left=x>=channels?row[x-channels]:0,above=previous[x],upperLeft=x>=channels?previous[x-channels]:0;const predictor=[0,left,above,Math.floor((left+above)/2),paeth(left,above,upperLeft)][filter];row[x]=(raw[pos++]+predictor)&255;}previous=row;}
  return [...previous.subarray(targetX*channels,targetX*channels+3)];
}

test('controlled browser: known credentials are redacted before storage and body screenshot is masked',async t=>{
  const key='sk-controlled-test-credential-ONLY-FAKE';let keys=[key];
  const {service,store,stats}=await setup(t,{fixturesOptions:{echoSecret:key},getExternalSecrets:()=>keys});
  const opened=await service.open('task-redaction','oa');
  assert.ok(opened.observation.text.includes('[REDACTED]'));assert.equal(JSON.stringify(opened).includes(key),false);
  assert.equal(find(opened.observation,'普通备注').sensitive,true);
  await assert.rejects(proposal(service,opened.session.id,opened.observation,key),e=>e.code==='KNOWN_SECRET');
  assert.equal(stats.inputs,0);assert.equal(stats.saves,0);
  const filename=await service.screenshot(opened.session.id);assert.equal(service.getSession(opened.session.id).screenshotRedacted,true);
  assert.deepEqual(pngRGBAt(await readFile(filename),30,30),[255,0,255]);
  keys=[];const reread=await service.read(opened.session.id);assert.equal(JSON.stringify(reread).includes(key),false);
  for(const kind of ['controlled_sessions','browser_approvals','browser_targets','audit'])assert.equal(JSON.stringify(store.all(kind)).includes(key),false,kind);
});

test('controlled browser: altered stored action tuple fails digest binding without input',async t=>{
  const {service,store,stats}=await setup(t);const {session,observation}=await service.open('task-binding','oa');
  const p=await proposal(service,session.id,observation);
  store.put('browser_approvals',p.id,{...p,actions:p.actions.map((a,i)=>i===0?{...a,value:'tampered'}:a)});
  await assert.rejects(service.decide(p.id,{decision:'approve',digest:p.digest}),e=>e.code==='APPROVAL_DIGEST');
  assert.equal(stats.inputs,0);assert.equal(stats.saves,0);
});


test('controlled browser: cancelling an in-flight resume/read returns a normal cancelled result',async t=>{
  const {service}=await setup(t);const opened=await service.open('task-resume-cancel','oa');
  const manual=await service.takeover(opened.session.id);
  const original=service.observe.bind(service);let enteredResolve,release;
  const entered=new Promise(resolve=>{enteredResolve=resolve;});const gate=new Promise(resolve=>{release=resolve;});
  service.observe=async live=>{enteredResolve();await gate;return original(live);};
  const resuming=service.resume(opened.session.id,{leaseToken:manual.leaseToken});
  await entered;const cancelling=service.cancel(opened.session.id);release();
  const [resumed,cancelled]=await Promise.all([resuming,cancelling]);
  assert.equal(resumed.cancelled,true);assert.equal(resumed.session.status,'cancelled');assert.equal(cancelled.status,'cancelled');
  assert.equal((await service.read(opened.session.id)).cancelled,true);
  assert.equal((await service.screenshot(opened.session.id)).cancelled,true);
  assert.equal(service.getSession(opened.session.id).status,'cancelled');
});
