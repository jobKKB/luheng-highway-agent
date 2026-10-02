import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startServer } from '../server.mjs';
import { validateCredentialBundle } from '../lib/persisted-credentials.mjs';
const expectedVersion = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
const wait = ms => new Promise(r => setTimeout(r, ms));
async function fixture(t, options = {}) {
 const dataDir = await mkdtemp(join(tmpdir(), 'luheng-v03-')); let app, cookie;
 const start = async extras => { app = await startServer({port:0,dataDir,stepDelay:1,...options,...extras}); cookie=(await fetch(app.url+'/')).headers.get('set-cookie').split(';')[0]; };
 await start();
 const request = async (path, method='GET', body) => fetch(app.url+path,{method,headers:{cookie,...(method==='GET'?{}:{'Content-Type':'application/json',origin:app.url})},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const json = async (path,method,body,status=200) => {const r=await request(path,method,body);const data=await r.json();assert.equal(r.status,status,JSON.stringify(data));return data;};
 t.after(async()=>{await app.close();await rm(dataDir,{recursive:true,force:true});});
 return {dataDir,get app(){return app;},request,json,restart:async extras=>{await app.close();await start(extras);}};
}

test('desktop feature is unavailable in browser-only mode, explicit consent is required', async t => {
 const h=await fixture(t);const state=await h.json('/api/state');
 assert.equal(state.system.version,expectedVersion);
 assert.equal((await h.json('/health')).version,expectedVersion); assert.equal(state.desktop.available,false);
 assert.deepEqual(state.schedules,[]);
 await h.json('/api/desktop/preferences','POST',{backgroundEnabled:true},409);
 await h.json('/api/desktop/credentials/save','POST',{confirmed:true},409);
});

test('explicit credential snapshot remains private and restores only matching model identities', async t => {
 let saved=null,backgroundEnabled=false,saves=0;
 const desktopBridge={status:async()=>({available:true,stored:!!saved,backend:'synthetic-test'}),preferences:async()=>({backgroundEnabled,trayAvailable:true}),setPreferences:async b=>(backgroundEnabled=b.backgroundEnabled,{backgroundEnabled,trayAvailable:true}),saveCredentials:async b=>{saved=structuredClone(b);saves++;return {available:true,stored:true,backend:'synthetic-test'};},forgetCredentials:async()=>{saved=null;}};
 const h=await fixture(t,{desktopBridge});
 await h.json('/api/desktop/credentials/save','POST',{},400);assert.equal(saves,0);
 await h.json('/api/desktop/credentials/save','POST',{confirmed:true},400);assert.equal(saves,0);
 const fake='FAKE_V03_KEY_NOT_A_REAL_SECRET';
 await h.json('/api/settings','POST',{mode:'demo',endpoint:'https://api.openai.com/v1',model:'test',budget:12,apiKey:fake});
 await h.json('/api/desktop/credentials/save','POST',{confirmed:true}); assert.equal(saves,1); assert.equal(saved.entries[0].secret,fake);
 assert.ok(!JSON.stringify(await h.json('/api/state')).includes(fake));
 await h.json('/api/desktop/preferences','POST',{backgroundEnabled:true}); assert.equal((await h.json('/api/state')).desktop.backgroundEnabled,true);
 await h.restart({persistedCredentials:saved}); assert.equal((await h.json('/api/state')).settings.hasApiKey,true);
 await h.json('/api/settings','POST',{mode:'demo',endpoint:'https://other.example/v1',model:'test',budget:12});
 await h.restart({persistedCredentials:saved}); assert.equal((await h.json('/api/state')).settings.hasApiKey,false);
 await h.json('/api/desktop/credentials/forget','POST',{confirmed:true}); assert.equal(saved,null);
 const database=await readFile(join(h.dataDir,'agent.sqlite'));assert.ok(!database.includes(Buffer.from(fake)));
});

test('malformed credential snapshots fail before restoring any entry', () => {
 const entry={kind:'global',id:'main',secret:'FAKE',configDigest:'a'.repeat(64)};
 for(const bundle of [{version:1,entries:[entry],extra:1},{version:1,entries:[{...entry,id:'other'}]},{version:1,entries:[{...entry,secret:'中'.repeat(1000)}]},{version:1,entries:[{...entry,extra:true}]}])assert.throws(()=>validateCredentialBundle(bundle),/格式/);
});

test('schedule HTTP create edit pause resume cancel persists across restarts', async t => {
 let time=Date.parse('2026-10-01T08:00:00Z');
 const h=await fixture(t,{scheduleOptions:{clock:()=>time,startTimer:false}});
 let s=await h.json('/api/schedules','POST',{title:'虚构周期报表',prompt:'汇总演示养护待办并生成周报',timezone:'Asia/Shanghai',recurrence:{type:'interval',intervalMinutes:5}},201);
 assert.equal(s.status,'active');assert.equal(s.timezone,'Asia/Shanghai');
 s=await h.json('/api/schedules/'+s.id,'PATCH',{title:'修订虚构周期报表'});assert.equal(s.title,'修订虚构周期报表');
 s=await h.json('/api/schedules/'+s.id+'/pause','POST',{});assert.equal(s.status,'paused');
 await h.restart();assert.equal((await h.json('/api/state')).schedules[0].status,'paused');
 s=await h.json('/api/schedules/'+s.id+'/resume','POST',{});assert.equal(s.status,'active');
 s=await h.json('/api/schedules/'+s.id+'/cancel','POST',{});assert.equal(s.status,'cancelled');
 await h.json('/api/schedules/'+s.id+'/resume','POST',{},400);
});

test('completed task generates downloadable persistent DOCX/XLSX and retains text artifact', async t => {
 const h=await fixture(t);const task=await h.json('/api/tasks','POST',{prompt:'汇总演示养护待办并生成周报'},201);
 let done;
 for(let i=0;i<200;i++){done=await h.json('/api/tasks/'+task.id);if(['failed','completed'].includes(done.status))break;await wait(20);}
 assert.equal(done.status,'completed',done.error);const original=done.artifact;
 for(const format of ['docx','xlsx']){
  const a=await h.json('/api/tasks/'+task.id+'/export','POST',{format},201);
  const response=await h.request(a.url);assert.equal(response.status,200);const data=Buffer.from(await response.arrayBuffer());assert.equal(data.subarray(0,2).toString(),'PK');assert.ok(response.headers.get('content-type').includes('openxmlformats'));
  const repeated=await h.json('/api/tasks/'+task.id+'/export','POST',{format});assert.equal(repeated.filename,a.filename);
 }
 done=await h.json('/api/tasks/'+task.id);assert.equal(done.exports.length,2);assert.deepEqual(done.artifact,original);
 await h.restart();done=await h.json('/api/tasks/'+task.id);assert.equal(done.exports.length,2);
 assert.equal((await h.request(done.exports[0].url)).status,200);
 assert.equal((await readdir(join(h.dataDir,'artifacts'))).length,3);
});
