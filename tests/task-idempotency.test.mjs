import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '../lib/store.mjs';
import {Engine} from '../lib/engine.mjs';

async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'luheng-idempotency-'));let store=new Store(dir),engine=new Engine(store,{close:async()=>{}});await engine.close();
 const f={get store(){return store;},get engine(){return engine;},async restart(){store.close();store=new Store(dir);engine=new Engine(store,{close:async()=>{}});await engine.close();}};
 t.after(async()=>{await engine.close();store.close();await rm(dir,{recursive:true,force:true});});return f;
}
const input=()=>({prompt:'Synthetic isolated retry test',agentId:'coordinator',budget:20,submissionId:randomUUID()});
test('accepted task retry reuses one persisted task and one creation audit without growing records',async t=>{
 const f=await fixture(t),body=input(),first=f.engine.create(body);const rows=f.store.db.prepare('SELECT count(*) AS n FROM records').get().n;
 for(let i=0;i<500;i++)assert.equal(f.engine.create(body).id,first.id);
 assert.equal(f.store.all('tasks').length,1);assert.equal(f.store.all('audit').filter(a=>a.action==='task.created').length,1);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM records').get().n,rows);assert.ok(JSON.stringify({submissionId:first.submissionId,submissionFingerprint:first.submissionFingerprint}).length<200);
});
test('idempotency survives restart and does not requeue an interrupted task',async t=>{
 const f=await fixture(t),body=input(),first=f.engine.create(body);await f.restart();const retried=f.engine.create(body);assert.equal(retried.id,first.id);assert.equal(retried.status,'failed');assert.equal(f.store.all('tasks').length,1);assert.equal(f.store.all('audit').filter(a=>a.action==='task.created').length,1);
});
test('same key with different prompt, role or budget is rejected without creating a task',async t=>{
 const f=await fixture(t),body=input();f.engine.create(body);
 for(const delta of [{prompt:'Different intent'},{agentId:'writer'},{budget:21}])assert.throws(()=>f.engine.create({...body,...delta}),/提交标识.*不同|提交内容.*不一致/);
 assert.equal(f.store.all('tasks').length,1);
});
test('intentional identical new tasks use independent keys; legacy no-key clients remain independent',async t=>{
 const f=await fixture(t),body=input(),first=f.engine.create(body),second=f.engine.create({...body,submissionId:randomUUID()});assert.notEqual(first.id,second.id);const legacy={...body};delete legacy.submissionId;assert.notEqual(f.engine.create(legacy).id,f.engine.create(legacy).id);assert.equal(f.store.all('tasks').length,4);
});
test('invalid submission keys are bounded and never persisted',async t=>{
 const f=await fixture(t);for(const submissionId of ['',null,4,{},'x','x'.repeat(101),'../unsafe-key-12345678'])assert.throws(()=>f.engine.create({...input(),submissionId}),/提交标识/);assert.equal(f.store.all('tasks').length,0);
});
test('accepted retry still resolves when active task capacity is reached',async t=>{
 const f=await fixture(t),body=input(),first=f.engine.create(body);for(let i=0;i<29;i++)f.engine.create(input());assert.equal(f.engine.create(body).id,first.id);assert.throws(()=>f.engine.create(input()),/30/);assert.equal(f.store.all('tasks').length,30);
});
