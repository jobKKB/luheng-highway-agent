import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';
import {MailService,mailContentHash} from '../lib/mail-adapter.mjs';
import {Store} from '../lib/store.mjs';
import {mailFixtures,message,TEST_PASSWORD} from './mail-fixtures.mjs';
const require=createRequire(import.meta.url);
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,timeout=8000){const end=Date.now()+timeout;while(Date.now()<end){if(await fn())return;await wait(10);}throw Error('Fixture condition timed out');}
async function setup(t,{timeoutMs=4000,getExternalSecrets}={}){const fixture=await mailFixtures();const dir=await mkdtemp(join(tmpdir(),'mail-adapter-'));const store=new Store(dir);let service=new MailService(store,{allowTestLocal:true,testTls:{ca:fixture.cert},timeoutMs,getExternalSecrets});await service.configure(fixture.config);const h={fixture,dir,store,get service(){return service;},draft(patch={}){return service.createDraft({accountId:'fixture',to:'recipient@example.invalid',subject:'Fabricated approved subject',text:'Fabricated exact body\nSecond line',...patch});},async restart(){await service.close();service=new MailService(store,{allowTestLocal:true,testTls:{ca:fixture.cert},timeoutMs,getExternalSecrets});}};t.after(async()=>{await service.close();store.close();await fixture.close();await rm(dir,{recursive:true,force:true});});return h;}

test('actual TLS IMAP reads MIME text with UIDVALIDITY + UID cursor, dedupes restart, and resets changed validity',async t=>{
 const h=await setup(t);const first=await h.service.readInbox({accountId:'fixture',limit:1});assert.equal(first.messages.length,1);assert.equal(first.messages[0].text.trim(),'Fabricated inbound message 1');assert.equal(first.cursor.uidValidity,'41');assert.equal(first.cursor.lastUid,1);assert.equal(first.hasMore,true);assert.ok(h.fixture.imap.commands.some(c=>c.includes('EXAMINE')));assert.ok(h.fixture.imap.commands.some(c=>c.includes('BODY.PEEK')));
 const second=await h.service.readInbox({accountId:'fixture'});assert.equal(second.messages.length,1);assert.equal(second.messages[0].uid,2);await h.restart();assert.equal(h.service.getPublicConfig('fixture').hasCredentials.imap,false);await assert.rejects(()=>h.service.readInbox({accountId:'fixture'}),e=>e.code==='MAIL_CREDENTIALS_MISSING');await h.service.configure(h.fixture.config);assert.equal((await h.service.readInbox({accountId:'fixture'})).messages.length,0);
 h.fixture.imap.messages.push({uid:3,raw:message(3,'新增虚构邮件')});assert.equal((await h.service.readInbox({accountId:'fixture'})).messages[0].text.trim(),'新增虚构邮件');h.fixture.imap.uidValidity=42;h.fixture.imap.messages=[{uid:1,raw:message(1,'new UID generation')}];const changed=await h.service.readInbox({accountId:'fixture'});assert.equal(changed.uidValidityChanged,true);assert.equal(changed.cursor.uidValidity,'42');assert.equal(changed.messages.length,1);assert.equal(h.store.all('mail_inbox').length,4);
});

test('SMTP sends only exact approved content; concurrent and repeated decisions send once; success persists',async t=>{
 const h=await setup(t);const draft=h.draft({subject:'已批准的中文主题'});const approval=h.service.requestSend(draft.id);assert.equal(approval.contentHash,mailContentHash(approval.snapshot));assert.equal(h.fixture.smtp.messages.length,0);const [a,b]=await Promise.all([h.service.decideSend(approval.id,'approve'),h.service.decideSend(approval.id,'approve')]);assert.equal(a.status,'sent');assert.equal(b.status,'sent');assert.equal(h.fixture.smtp.messages.length,1);const parsed=await require('mailparser').simpleParser(h.fixture.smtp.messages[0].raw);assert.equal(parsed.subject,draft.subject);assert.equal(parsed.text.trim(),draft.text);assert.equal(parsed.to.value[0].address,draft.to[0]);assert.equal(parsed.messageId,draft.messageId);assert.deepEqual(h.fixture.smtp.messages[0].envelope.to,draft.to);
 await h.restart();const again=await h.service.decideSend(approval.id,'approve');assert.equal(again.status,'sent');assert.equal(again.attempts,1);assert.equal(h.fixture.smtp.messages.length,1);
});

test('draft mutation invalidates approval and rejection/cancellation sends no messages',async t=>{
 const h=await setup(t);let draft=h.draft();let approval=h.service.requestSend(draft.id);h.store.put('mail_outbox',draft.id,{...h.store.get('mail_outbox',draft.id),text:'tampered after approval'});await assert.rejects(()=>h.service.decideSend(approval.id,'approve'),e=>e.code==='MAIL_CONTENT_CHANGED');assert.equal(h.store.get('mail_approvals',approval.id).status,'invalidated');
 draft=h.draft();approval=h.service.requestSend(draft.id);const rejected=await h.service.decideSend(approval.id,'reject');assert.equal(rejected.status,'rejected');await assert.rejects(()=>h.service.decideSend(approval.id,'approve'));
 draft=h.draft();approval=h.service.requestSend(draft.id);assert.equal((await h.service.cancelSend(draft.id)).errorCode,'MAIL_CANCELLED');await assert.rejects(()=>h.service.decideSend(approval.id,'approve'));assert.equal(h.fixture.smtp.connections,0);assert.equal(h.fixture.smtp.messages.length,0);
});

test('post-DATA disconnect yields durable unknown and cannot resend',async t=>{
 const h=await setup(t);h.fixture.smtp.mode='drop-after-data';const draft=h.draft(),approval=h.service.requestSend(draft.id);const result=await h.service.decideSend(approval.id,'approve');assert.equal(result.status,'unknown');assert.equal(result.dataStarted,true);assert.equal(h.fixture.smtp.messages.length,1);await h.restart();assert.equal((await h.service.decideSend(approval.id,'approve')).status,'unknown');assert.throws(()=>h.service.requestSend(draft.id),e=>e.code==='MAIL_RETRY_BLOCKED');assert.equal(h.fixture.smtp.messages.length,1);
});

test('cancel before DATA is failed; cancel after DATA is unknown, without retries',async t=>{
 const h=await setup(t);h.fixture.smtp.mode='hold-before-data';let draft=h.draft(),approval=h.service.requestSend(draft.id);let sending=h.service.decideSend(approval.id,'approve');await until(()=>h.fixture.smtp.dataCommands===1);let cancelled=await h.service.cancelSend(draft.id);assert.equal(cancelled.status,'failed');assert.equal(cancelled.errorCode,'MAIL_CANCELLED');await sending;assert.equal(h.fixture.smtp.messages.length,0);
 h.fixture.smtp.mode='hold-after-data';draft=h.draft();approval=h.service.requestSend(draft.id);sending=h.service.decideSend(approval.id,'approve');await until(()=>h.fixture.smtp.messages.length===1);cancelled=await h.service.cancelSend(draft.id);assert.equal(cancelled.status,'unknown');await sending;assert.throws(()=>h.service.requestSend(draft.id));assert.equal(h.fixture.smtp.messages.length,1);
});

test('credentials and provider echoes never persist and TLS certificate validation is not bypassed',async t=>{
 const h=await setup(t);assert.ok(!JSON.stringify(h.service.getPublicConfig()).includes(TEST_PASSWORD));h.fixture.smtp.mode='reject-auth';let draft=h.draft(),approval=h.service.requestSend(draft.id);const failed=await h.service.decideSend(approval.id,'approve');assert.equal(failed.status,'failed');assert.ok(!JSON.stringify(failed).includes(TEST_PASSWORD));
 h.fixture.imap.messages=[{uid:1,raw:message(1,'server echoed '+TEST_PASSWORD)}];const inbox=await h.service.readInbox({accountId:'fixture'});assert.ok(!JSON.stringify(inbox).includes(TEST_PASSWORD));assert.match(inbox.messages[0].text,/REDACTED/);for(const kind of ['mail_accounts','mail_outbox','mail_approvals','mail_inbox','mail_cursors','audit'])assert.ok(!JSON.stringify(h.store.all(kind)).includes(TEST_PASSWORD));for(const name of await readdir(h.dir)){if(!name.startsWith('agent.sqlite'))continue;assert.ok(!(await readFile(join(h.dir,name))).includes(Buffer.from(TEST_PASSWORD)));}
 const noCA=new MailService(h.store,{allowTestLocal:true,timeoutMs:2000});await noCA.configure(h.fixture.config);await assert.rejects(()=>noCA.readInbox({accountId:'fixture'}),e=>e.code==='MAIL_IMAP_FAILED');await noCA.close();
});

test('timeouts and read cancellation terminate the TLS session without cursor progress',async t=>{
 const h=await setup(t,{timeoutMs:300});h.fixture.imap.mode='hold-search';const ac=new AbortController();const read=h.service.readInbox({accountId:'fixture',signal:ac.signal});await until(()=>h.fixture.imap.commands.some(c=>c.includes('UID SEARCH')));ac.abort();await assert.rejects(()=>read,e=>e.code==='MAIL_CANCELLED');assert.equal(h.store.all('mail_cursors').length,0);
 h.fixture.smtp.mode='no-greeting';const draft=h.draft(),approval=h.service.requestSend(draft.id);const result=await h.service.decideSend(approval.id,'approve');assert.equal(result.status,'failed');assert.equal(result.errorCode,'MAIL_TIMEOUT');assert.equal(h.fixture.smtp.messages.length,0);
});

test('interrupted sending becomes unknown on startup; transport edits cannot reuse approval',async t=>{
 const h=await setup(t);const draft=h.draft();const approval=h.service.requestSend(draft.id);h.store.put('mail_outbox',draft.id,{...h.store.get('mail_outbox',draft.id),status:'sending'});await h.restart();assert.equal(h.store.get('mail_outbox',draft.id).status,'unknown');assert.throws(()=>h.service.requestSend(draft.id));
 await h.service.configure(h.fixture.config);const next=h.draft(),approval2=h.service.requestSend(next.id);await h.service.configure({...h.fixture.config,from:'another@example.invalid'});await assert.rejects(()=>h.service.decideSend(approval2.id,'approve'),e=>e.code==='MAIL_ACCOUNT_CHANGED');assert.equal(h.fixture.smtp.messages.length,0);
});

test('public configuration rejects insecure destinations and draft header injection',async t=>{
 const h=await setup(t);const prod=new MailService(h.store);await assert.rejects(()=>prod.configure(h.fixture.config),e=>['MAIL_PORT_INVALID','MAIL_HOST_BLOCKED'].includes(e.code));assert.throws(()=>h.draft({to:'recipient@example.invalid\r\nBcc: hidden@example.invalid'}));assert.throws(()=>h.draft({subject:'hello\r\nBcc: hidden@example.invalid'}));assert.throws(()=>h.draft({text:'leak '+TEST_PASSWORD}),e=>e.code==='MAIL_SECRET_CONTENT');await prod.close();
});

test('IMAP and SMTP mandatory STARTTLS succeed without sending credentials before encryption',async t=>{
 const h=await setup(t);await h.service.configure({...h.fixture.config,imap:{...h.fixture.config.imap,secure:false,port:h.fixture.starttlsPorts.imap},smtp:{...h.fixture.config.smtp,secure:false,port:h.fixture.starttlsPorts.smtp}});const inbox=await h.service.readInbox({accountId:'fixture'});assert.equal(inbox.messages.length,2);const draft=h.draft(),approval=h.service.requestSend(draft.id);assert.equal((await h.service.decideSend(approval.id,'approve')).status,'sent');assert.ok(h.fixture.imap.commands.some(x=>/^PRETLS:.* STARTTLS$/.test(x)));assert.ok(h.fixture.smtp.commands.includes('PRETLS:STARTTLS'));assert.ok(![...h.fixture.smtp.commands,...h.fixture.imap.commands].some(x=>/^PRETLS:.*AUTH|^PRETLS:.*LOGIN /.test(x)));
});

test('recipient rejection stays definitively failed and edited drafts require a new snapshot',async t=>{
 const h=await setup(t);h.fixture.smtp.mode='reject-recipient';const draft=h.draft(),approval=h.service.requestSend(draft.id);const result=await h.service.decideSend(approval.id,'approve');assert.equal(result.status,'failed');assert.equal(result.dataStarted,undefined);assert.equal(h.fixture.smtp.dataCommands,0);assert.equal(h.fixture.smtp.messages.length,0);
 const next=h.draft(),oldApproval=h.service.requestSend(next.id);const edited=h.service.updateDraft(next.id,{text:'Explicit newly edited body'});assert.equal(edited.status,'draft');assert.equal(h.service.getApproval(oldApproval.id).status,'invalidated');await assert.rejects(()=>h.service.decideSend(oldApproval.id,'approve'));const nextApproval=h.service.requestSend(next.id);assert.notEqual(nextApproval.contentHash,oldApproval.contentHash);assert.equal(nextApproval.snapshot.text,edited.text);assert.deepEqual(nextApproval.snapshot.transport,h.fixture.config.smtp&&{host:'127.0.0.1',port:h.fixture.config.smtp.port,secure:true,user:h.fixture.config.smtp.user});
});

test('shutdown cancels in-flight IMAP and credential rotation retains only in-memory redaction history',async t=>{
 const h=await setup(t);await h.service.configure({...h.fixture.config,smtp:{...h.fixture.config.smtp,password:'new-fabricated-secret-94'}});assert.ok(h.service.getSecrets().includes(TEST_PASSWORD));assert.equal(h.service.sanitize('echo '+TEST_PASSWORD+' and new-fabricated-secret-94'),'echo [REDACTED] and [REDACTED]');h.fixture.imap.mode='hold-search';const pending=h.service.readInbox({accountId:'fixture'});const caught=assert.rejects(()=>pending,e=>e.code==='MAIL_CANCELLED');await until(()=>h.fixture.imap.commands.some(x=>x.includes('UID SEARCH')));await h.service.close();await caught;assert.equal(h.service.getSecrets().length,0);assert.equal(h.store.all('mail_cursors').length,0);
});

test('pending approval survives restart with credentials re-entered; interrupted approved-before-send requires new approval',async t=>{
 const h=await setup(t);let draft=h.draft({taskId:'fabricated-task-id'}),approval=h.service.requestSend(draft.id);assert.equal(approval.taskId,'fabricated-task-id');await h.restart();await assert.rejects(()=>h.service.decideSend(approval.id,'approve'),e=>e.code==='MAIL_CREDENTIALS_MISSING');assert.equal(h.service.getApproval(approval.id).status,'pending');await h.service.configure(h.fixture.config);assert.equal((await h.service.decideSend(approval.id,'approve')).status,'sent');
 draft=h.draft();approval=h.service.requestSend(draft.id);h.store.put('mail_approvals',approval.id,{...approval,status:'approved'});h.store.put('mail_outbox',draft.id,{...h.service.getOutbox(draft.id),status:'approved'});await h.restart();assert.equal(h.service.getOutbox(draft.id).status,'failed');assert.equal(h.service.getOutbox(draft.id).errorCode,'MAIL_INTERRUPTED_BEFORE_SEND');assert.equal(h.fixture.smtp.messages.length,1);await h.service.configure(h.fixture.config);const renewed=h.service.requestSend(draft.id);assert.notEqual(renewed.id,approval.id);assert.equal((await h.service.decideSend(renewed.id,'approve')).status,'sent');assert.equal(h.fixture.smtp.messages.length,2);
});

test('timeout after DATA is unknown and an already aborted approval starts no connection',async t=>{
 const h=await setup(t,{timeoutMs:300});h.fixture.smtp.mode='hold-after-data';let draft=h.draft(),approval=h.service.requestSend(draft.id);assert.equal((await h.service.decideSend(approval.id,'approve')).status,'unknown');assert.equal(h.fixture.smtp.messages.length,1);const count=h.fixture.smtp.connections;const ac=new AbortController();ac.abort();draft=h.draft();approval=h.service.requestSend(draft.id);const result=await h.service.decideSend(approval.id,'approve',{signal:ac.signal});assert.equal(result.status,'failed');assert.equal(result.errorCode,'MAIL_CANCELLED');assert.equal(h.fixture.smtp.connections,count);
});

test('credential strings cannot be saved in public account fields or returned through task metadata',async t=>{
 const h=await setup(t);await assert.rejects(()=>h.service.configure({...h.fixture.config,accountId:TEST_PASSWORD}),e=>e.code==='MAIL_SECRET_CONFIG');const draft=h.draft({taskId:TEST_PASSWORD});assert.ok(!JSON.stringify(draft).includes(TEST_PASSWORD));assert.equal(draft.taskId,'[REDACTED]');assert.throws(()=>h.draft({subject:'invalid\0subject'}),e=>e.code==='MAIL_SUBJECT');assert.ok(!JSON.stringify(h.store.db.prepare('SELECT * FROM records').all()).includes(TEST_PASSWORD));
});

test('all external model-provider secrets are redacted from TLS inbox and blocked in create/edit drafts',async t=>{
 let external=['fake-global-model-key-228','fake-other-role-key-229'];const h=await setup(t,{getExternalSecrets:()=>external});h.fixture.imap.messages=[{uid:1,raw:message(1,'echo '+external.join(' and '))}];const inbox=await h.service.readInbox({accountId:'fixture'});for(const secret of external){assert.ok(!JSON.stringify(inbox).includes(secret));assert.throws(()=>h.draft({text:'do not send '+secret}),e=>e.code==='MAIL_SECRET_CONTENT');const draft=h.draft();assert.throws(()=>h.service.updateDraft(draft.id,{text:'do not save '+secret}),e=>e.code==='MAIL_SECRET_CONTENT');assert.ok(!JSON.stringify(h.store.db.prepare('SELECT * FROM records').all()).includes(secret));}
 const old=external[0];external=['new-model-key-230'];assert.equal(h.service.sanitize('late reply '+old),'late reply [REDACTED]');assert.ok(h.service.getSecrets().includes('new-model-key-230'));
});

test('credentials added after draft creation are rechecked immediately before approval sends',async t=>{
 let secrets=[];const h=await setup(t,{getExternalSecrets:()=>secrets});const laterSecret='becomes-an-external-credential-888';const draft=h.draft({text:'original text '+laterSecret});const approval=h.service.requestSend(draft.id);secrets=[laterSecret];await assert.rejects(()=>h.service.decideSend(approval.id,'approve'),e=>e.code==='MAIL_SECRET_CONTENT');assert.equal(h.fixture.smtp.connections,0);assert.equal(h.service.getApproval(approval.id).status,'pending');assert.throws(()=>h.service.requestSend(draft.id),e=>e.code==='MAIL_SECRET_CONTENT');
});
