import {createHash, randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {Readable} from 'node:stream';
import dns from 'node:dns/promises';
import net from 'node:net';
import {redactSecrets} from './redact.mjs';

const require=createRequire(import.meta.url);
const now=()=>new Date().toISOString();
const clone=value=>structuredClone(value);
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const ADDRESS=/^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$/;
const terminal=new Set(['sent','unknown','rejected','failed']);
export class MailError extends Error {constructor(code,message){super(message);this.name='MailError';this.code=code;}}
const fail=(code,message)=>{throw new MailError(code,message);};
const publicEndpoint=x=>({host:x.host,port:x.port,secure:x.secure,user:x.user});
const fingerprint=config=>hash({accountId:config.accountId,from:config.from,imap:config.imap,smtp:config.smtp});
export const mailContentHash=snapshot=>hash({accountId:snapshot.accountId,from:snapshot.from,to:snapshot.to,subject:snapshot.subject,text:snapshot.text,messageId:snapshot.messageId,date:snapshot.date,transport:snapshot.transport,transportHash:snapshot.transportHash});
function privateIp(ip){
 if(net.isIPv4(ip)){const p=ip.split('.').map(Number);return p[0]===0||p[0]===10||p[0]===127||p[0]>=224||(p[0]===169&&p[1]===254)||(p[0]===172&&p[1]>=16&&p[1]<=31)||(p[0]===192&&(p[1]===168||p[1]===0))||(p[0]===100&&p[1]>=64&&p[1]<=127)||(p[0]===198&&([18,19].includes(p[1])||(p[1]===51&&p[2]===100)))||(p[0]===203&&p[1]===0&&p[2]===113);}
 return !net.isIPv6(ip)||ip==='::'||ip==='::1'||/^(?:f[cd]|fe[89ab]|ff|2001:db8:|::ffff:)/i.test(ip);
}
function address(value,label='邮箱地址'){
 if(typeof value!=='string'||value.length>254||!ADDRESS.test(value)||/[\r\n]/.test(value))fail('MAIL_ADDRESS',`${label}须为单一有效ASCII邮箱地址`);
 return value;
}
function abortError(signal){return new MailError(signal?.reason?.name==='TimeoutError'?'MAIL_TIMEOUT':'MAIL_CANCELLED',signal?.reason?.name==='TimeoutError'?'邮件操作超时，已关闭连接':'邮件操作已取消');}
function withAbort(promise,signal,close=()=>{}){
 if(signal?.aborted){close();return Promise.reject(abortError(signal));}
 return new Promise((resolve,reject)=>{const onAbort=()=>{close();reject(abortError(signal));};signal?.addEventListener('abort',onAbort,{once:true});Promise.resolve(promise).then(resolve,reject).finally(()=>signal?.removeEventListener('abort',onAbort));});
}

/** TLS-only mail protocols; caller remains responsible for user authorization and role ACLs. */
export class MailService {
 constructor(store,{allowTestLocal=false,testTls,timeoutMs=15000,imapFactory,smtpFactory,getExternalSecrets=()=>[]}={}){
  if(testTls&&!allowTestLocal)fail('MAIL_TEST_ONLY','测试TLS设置只能用于显式本地测试构造器');
  if(typeof getExternalSecrets!=='function')fail('MAIL_SECRET_PROVIDER','秘密脱敏提供器无效');
  this.getExternalSecrets=getExternalSecrets;
  this.store=store;this.allowTestLocal=allowTestLocal;this.testTls=testTls;this.timeoutMs=Math.max(100,Math.min(60000,Number(timeoutMs)||15000));
  this.imapFactory=imapFactory||((options)=>new (require('imapflow').ImapFlow)(options));
  this.smtpFactory=smtpFactory||((options)=>new (require('nodemailer/lib/smtp-connection'))(options));
  this.credentials=new Map();this.secretHistory=new Set();this.active=new Map();this.inboxLocks=new Map();this.readControllers=new Map();this.closed=false;
  for(const draft of store.all('mail_outbox'))if(draft.status==='sending')this._put('mail_outbox',draft.id,{...draft,status:'unknown',errorCode:'MAIL_INTERRUPTED',error:'发送时服务中断，投递结果不确定；禁止自动重试',updatedAt:now()});
  for(const draft of store.all('mail_outbox'))if(draft.status==='approved')this._put('mail_outbox',draft.id,{...draft,status:'failed',errorCode:'MAIL_INTERRUPTED_BEFORE_SEND',error:'发送前服务中断，需要重新申请审批',updatedAt:now()});
 }
 _secrets(){
  let external;try{external=this.getExternalSecrets();}catch{fail('MAIL_SECRET_PROVIDER','无法取得安全脱敏上下文');}
  if(!Array.isArray(external))fail('MAIL_SECRET_PROVIDER','安全脱敏上下文必须返回字符串数组');
  const current=[...[...this.credentials.values()].flatMap(c=>Object.values(c).filter(x=>x?.password).flatMap(x=>[x.password,Buffer.from('\0'+x.user+'\0'+x.password).toString('base64')])),...(Array.isArray(external)?external:[])];
  for(const secret of current)if(typeof secret==='string'&&secret.length)this.secretHistory.add(secret);
  return [...this.secretHistory];
 }
 _assertSafeContent(snapshot){const values=[snapshot.from,...(snapshot.to||[]),snapshot.subject,snapshot.text];if(this._secrets().some(secret=>values.some(value=>typeof value==='string'&&value.includes(secret))))fail('MAIL_SECRET_CONTENT','邮件内容疑似包含当前或历史凭据，已阻止发送');}
 getSecrets(){return [...new Set(this._secrets())];}
 sanitize(value){return this._clean(value);}
 getOutbox(id){const value=this.store.get('mail_outbox',id);return value?this._clean(value):null;}
 getApproval(id){const value=this.store.get('mail_approvals',id);return value?this._clean(value):null;}
 _clean(value){return redactSecrets(value,this._secrets());}
 _put(kind,id,value){const safe=this._clean(value);this.store.put(kind,id,safe);return clone(safe);}
 _audit(action,id){this.store.audit(action,`邮件操作 ${id}`);}
 _config(accountId){const c=this.store.get('mail_accounts',accountId);if(!c)fail('MAIL_ACCOUNT_MISSING','邮件账户尚未配置');return c;}
 _auth(accountId,protocol){const c=this.credentials.get(accountId)?.[protocol];if(!c?.password)fail('MAIL_CREDENTIALS_MISSING','邮件凭据仅保存在内存，启动后请在安全设置中重新输入');return c;}
 _signal(signal){return signal?AbortSignal.any([signal,AbortSignal.timeout(this.timeoutMs)]):AbortSignal.timeout(this.timeoutMs);}
 async _target(endpoint,signal){
  if(this.allowTestLocal&&endpoint.host==='127.0.0.1')return {host:endpoint.host,tls:{...this.testTls,minVersion:'TLSv1.2',rejectUnauthorized:true}};
  if(endpoint.host==='localhost'||endpoint.host.endsWith('.local')||endpoint.host.endsWith('.internal'))fail('MAIL_HOST_BLOCKED','不允许本机或内网邮件端点');
  let found;try{found=await withAbort(dns.lookup(endpoint.host,{all:true}),signal);}catch(e){if(e instanceof MailError)throw e;fail('MAIL_HOST_DNS','邮件服务器域名无法解析');}
  if(!found.length||found.some(x=>privateIp(x.address)))fail('MAIL_HOST_BLOCKED','邮件服务器必须解析为公开网络地址');
  return {host:found[0].address,tls:{minVersion:'TLSv1.2',rejectUnauthorized:true,servername:endpoint.host}};
 }
 async configure({accountId='main',from,imap,smtp}){
  if(this.closed)fail('MAIL_CLOSED','邮件服务已关闭');
  if(typeof accountId!=='string'||!/^[\w-]{1,80}$/.test(accountId))fail('MAIL_ACCOUNT_INVALID','账户标识无效');
  from=address(from,'发件人');const previous=this.credentials.get(accountId)||{};const credentials={};const result={accountId,from,updatedAt:now()};
  for(const [protocol,input] of Object.entries({imap,smtp})){
   if(!input)continue;
   if(typeof input.host!=='string'||input.host.length>253||!/^([A-Za-z0-9.-]+|[A-Fa-f0-9:]+)$/.test(input.host)||input.host.endsWith('.'))fail('MAIL_HOST_INVALID','邮件服务器主机名无效');
   const secure=input.secure!==false;const port=Number(input.port||(protocol==='imap'?(secure?993:143):(secure?465:587)));
   if(!Number.isInteger(port)||port<1||port>65535||(!this.allowTestLocal&&!(protocol==='imap'?[993,143]:[465,587]).includes(port)))fail('MAIL_PORT_INVALID','邮件服务器端口未获允许');
   if(typeof input.user!=='string'||!input.user.trim()||input.user.length>254||/[\r\n\0]/.test(input.user))fail('MAIL_USER_INVALID','邮件用户名无效');
   const endpoint={host:input.host.toLowerCase(),port,secure,user:input.user};await this._target(endpoint,this._signal());
   const old=this.store.get('mail_accounts',accountId)?.[protocol];const same=old&&hash(old)===hash(endpoint);
   const password=input.password===undefined&&same?previous[protocol]?.password:input.password;
   if(password!==undefined&&(typeof password!=='string'||!password||password.length>2000))fail('MAIL_CREDENTIAL_INVALID','邮件凭据格式无效');
   credentials[protocol]={user:input.user,password:password||''};result[protocol]=publicEndpoint(endpoint);
  }
  if(!result.imap&&!result.smtp)fail('MAIL_ACCOUNT_INVALID','至少配置IMAP或SMTP');
  if(this.closed)fail('MAIL_CLOSED','邮件服务已关闭');
  const candidateSecrets=[...this._secrets(),...Object.values(credentials).map(x=>x.password).filter(Boolean)];
  if(candidateSecrets.some(secret=>JSON.stringify(result).includes(secret)))fail('MAIL_SECRET_CONFIG','公开账户字段不能包含密码或当前凭据');
  this.credentials.set(accountId,credentials);for(const secret of this._secrets())this.secretHistory.add(secret);this._put('mail_accounts',accountId,result);this._audit('mail.configured',accountId);return this.getPublicConfig(accountId);
 }
 getPublicConfig(accountId){
  const present=c=>({...c,hasCredentials:{imap:!!this.credentials.get(c.accountId)?.imap?.password,smtp:!!this.credentials.get(c.accountId)?.smtp?.password},credentialStorage:'memory-only',tlsRequired:true});
  return accountId?present(this._config(accountId)):this.store.all('mail_accounts').map(present);
 }
 async readInbox({accountId='main',signal,limit=50}={}){
  if(this.closed)fail('MAIL_CLOSED','邮件服务已关闭');if(this.inboxLocks.has(accountId))return this.inboxLocks.get(accountId);
  const controller=new AbortController();this.readControllers.set(accountId,controller);const combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
  const promise=this._readInbox({accountId,signal:combined,limit}).finally(()=>{this.inboxLocks.delete(accountId);this.readControllers.delete(accountId);});this.inboxLocks.set(accountId,promise);return promise;
 }
 async _readInbox({accountId,signal,limit}){
  this._secrets();
  const config=this._config(accountId);if(!config.imap)fail('MAIL_IMAP_MISSING','账户未配置IMAP');const auth=this._auth(accountId,'imap');const combined=this._signal(signal);const endpoint=await this._target(config.imap,combined);const client=this.imapFactory({...config.imap,...endpoint,auth:{user:auth.user,pass:auth.password},...(config.imap.secure?{}:{doSTARTTLS:true}),logger:false,logRaw:false,maxLiteralSize:65536,maxLineLength:65536,maxResponseSize:131072,disableAutoIdle:true,disableCompression:true,disableAutoEnable:true,connectionTimeout:this.timeoutMs,greetingTimeout:this.timeoutMs,socketTimeout:this.timeoutMs});
  client.on('error',()=>{});let lock;
  const work=(async()=>{
   await client.connect();lock=await client.getMailboxLock('INBOX',{readOnly:true});
   const uidValidity=String(client.mailbox.uidValidity),uidNext=Number(client.mailbox.uidNext||1);if(!/^\d+$/.test(uidValidity)||!Number.isSafeInteger(uidNext))fail('MAIL_IMAP_PROTOCOL','服务器未提供可靠的UID标识');
   const cursorId=accountId+':INBOX';const old=this.store.get('mail_cursors',cursorId);const changed=!!old&&(old.uidValidity!==uidValidity||old.accountFingerprint!==fingerprint(config));const last=old&&!changed?old.lastUid:0;
   const upper=Math.min(uidNext-1,last+1000);let uids=[];
   if(upper>last)uids=(await client.search({uid:`${last+1}:${upper}`},{uid:true})).filter(u=>Number.isSafeInteger(u)&&u>last&&u<=upper).sort((a,b)=>a-b);
   const selected=uids.slice(0,Math.max(1,Math.min(100,Math.floor(Number(limit)||50))));let records=[];
   if(selected.length){const rows=await client.fetchAll(selected,{uid:true,envelope:true,flags:true,size:true,source:{start:0,maxLength:65536}},{uid:true});
    const {simpleParser}=require('mailparser');
    for(const row of rows){if(!selected.includes(row.uid))continue;const source=Buffer.from(row.source||'').subarray(0,65536);const parsed=await simpleParser(source,{skipHtmlToText:true,skipTextToHtml:true,skipImageLinks:true});
     const item={id:`${accountId}:INBOX:${uidValidity}:${row.uid}`,accountId,mailbox:'INBOX',uidValidity,uid:row.uid,subject:String(parsed.subject||row.envelope?.subject||'').slice(0,1000),from:parsed.from?.text||'',to:parsed.to?.text||'',text:String(parsed.text||'').slice(0,65536),messageId:parsed.messageId||row.envelope?.messageId||null,date:parsed.date?.toISOString()||null,flags:[...(row.flags||[])],size:Number(row.size||source.length),truncated:Number(row.size||0)>source.length,readAt:now()};records.push(this._clean(item));
    }
   }
   if(combined.aborted)throw abortError(combined);
   const lastUid=selected.length<uids.length?selected.at(-1):Math.max(last,upper);
   const cursor={id:cursorId,accountId,mailbox:'INBOX',uidValidity,lastUid,accountFingerprint:fingerprint(config),updatedAt:now()};
   const commit=()=>{for(const item of records)this._put('mail_inbox',item.id,item);this._put('mail_cursors',cursorId,cursor);this._audit('mail.inbox.read',accountId);};this.store.transaction?this.store.transaction(commit):commit();
   return {accountId,messages:records,cursor,uidValidityChanged:changed,hasMore:lastUid<uidNext-1};
  })();
  try{return await withAbort(work,combined,()=>client.close());}catch(e){if(e instanceof MailError)throw e;fail('MAIL_IMAP_FAILED','IMAP读取失败，请检查TLS、账号权限与服务器设置');}finally{lock?.release();client.close();}
 }
 createDraft({accountId='main',to,subject,text,taskId=null}){
  if(this.closed)fail('MAIL_CLOSED','邮件服务已关闭');
  const config=this._config(accountId);if(!config.smtp)fail('MAIL_SMTP_MISSING','账户未配置SMTP');
  const recipients=Array.isArray(to)?to:[to];if(!recipients.length||recipients.length>20)fail('MAIL_RECIPIENTS','收件人须为1至20个');const unique=[...new Set(recipients.map(x=>address(x,'收件人')))];
  if(typeof subject!=='string'||!subject.trim()||subject.length>300||/[\u0000-\u001f\u007f]/.test(subject))fail('MAIL_SUBJECT','主题须为单行1至300字符');
  if(typeof text!=='string'||!text.trim()||Buffer.byteLength(text)>100000)fail('MAIL_BODY','纯文本正文须为1至100000字节');
  if(this._secrets().some(secret=>[subject,text,...unique,config.from].some(value=>value.includes(secret))))fail('MAIL_SECRET_CONTENT','邮件内容疑似包含当前凭据，已阻止保存');
  const id=randomUUID();const snapshot={accountId,from:config.from,to:unique,subject,text,messageId:`<${id}@highway-agent.invalid>`,date:now(),transport:clone(config.smtp),transportHash:fingerprint(config)};
  const draft={id,...snapshot,contentHash:mailContentHash(snapshot),status:'draft',taskId,createdAt:now(),updatedAt:now(),attempts:0};const safe=this._put('mail_outbox',id,draft);this._audit('mail.draft.created',id);return safe;
 }
 updateDraft(id,patch){
  if(this.closed)fail('MAIL_CLOSED','邮件服务已关闭');
  const old=this.store.get('mail_outbox',id);if(!old)fail('MAIL_DRAFT_MISSING','邮件草稿不存在');if(['sending','sent','unknown','approved'].includes(old.status))fail('MAIL_DRAFT_LOCKED','该发送状态不允许修改内容');
  const candidate=this.createDraft({accountId:old.accountId,to:patch.to??old.to,subject:patch.subject??old.subject,text:patch.text??old.text,taskId:old.taskId});this.store.delete?.('mail_outbox',candidate.id);
  for(const approval of this.store.all('mail_approvals').filter(a=>a.draftId===id&&a.status==='pending'))this._put('mail_approvals',approval.id,{...approval,status:'invalidated',decidedAt:now()});
  const result={...candidate,id,messageId:old.messageId,date:old.date,createdAt:old.createdAt};result.contentHash=mailContentHash(result);return this._put('mail_outbox',id,result);
 }
 requestSend(draftId){
  if(this.closed)fail('MAIL_CLOSED','邮件服务已关闭');
  const draft=this.store.get('mail_outbox',draftId);if(!draft)fail('MAIL_DRAFT_MISSING','邮件草稿不存在');
  this._assertSafeContent(draft);
  if(draft.status==='pending_approval')return this.store.get('mail_approvals',draft.approvalId);
  if(!['draft','rejected','failed'].includes(draft.status)||draft.dataStarted)fail('MAIL_RETRY_BLOCKED','已发送、发送中或结果不确定的邮件不可重复发送');
  if(mailContentHash(draft)!==draft.contentHash)fail('MAIL_CONTENT_CHANGED','邮件内容已改变，请重新保存草稿');
  const config=this._config(draft.accountId);if(fingerprint(config)!==draft.transportHash)fail('MAIL_ACCOUNT_CHANGED','邮件服务器或账户已改变，请重新创建草稿');
  const snapshot=Object.fromEntries(['accountId','from','to','subject','text','messageId','date','transport','transportHash'].map(k=>[k,clone(draft[k])]));
  const approval={id:randomUUID(),draftId,taskId:draft.taskId,type:'mail.send',status:'pending',contentHash:draft.contentHash,snapshot,summary:`向 ${draft.to.join(', ')} 发送邮件：${draft.subject}`,createdAt:now()};this._put('mail_approvals',approval.id,approval);this._put('mail_outbox',draftId,{...draft,status:'pending_approval',approvalId:approval.id,updatedAt:now()});this._audit('mail.approval.requested',draftId);return clone(approval);
 }
 async decideSend(approvalId,decision,{signal}={}){
  if(this.closed)fail('MAIL_CLOSED','邮件服务已关闭');
  if(!['approve','reject'].includes(decision))fail('MAIL_DECISION','无效邮件审批决定');
  const approval=this.store.get('mail_approvals',approvalId);if(!approval)fail('MAIL_APPROVAL_MISSING','邮件审批不存在');const draft=this.store.get('mail_outbox',approval.draftId);if(!draft)fail('MAIL_DRAFT_MISSING','邮件草稿不存在');
  if(['sent','unknown'].includes(draft.status))return draft;
  if(this.active.has(draft.id)&&decision==='approve')return this.active.get(draft.id).promise;
  if(approval.status!=='pending'){if(['sent','unknown'].includes(draft.status))return draft;fail('MAIL_APPROVAL_USED','邮件审批已经处理，未重复执行');}
  if(draft.status!=='pending_approval'||draft.approvalId!==approvalId||mailContentHash(draft)!==approval.contentHash||mailContentHash(approval.snapshot)!==approval.contentHash||draft.contentHash!==approval.contentHash){this._put('mail_approvals',approvalId,{...approval,status:'invalidated',decidedAt:now()});this._put('mail_outbox',draft.id,{...draft,status:'draft',errorCode:'MAIL_CONTENT_CHANGED',updatedAt:now()});fail('MAIL_CONTENT_CHANGED','邮件内容已改变，原审批已失效');}
  if(decision==='reject'){this._put('mail_approvals',approvalId,{...approval,status:'rejected',decidedAt:now()});const result=this._put('mail_outbox',draft.id,{...draft,status:'rejected',updatedAt:now()});this._audit('mail.send.rejected',draft.id);return result;}
  this._assertSafeContent(approval.snapshot);
  const config=this._config(draft.accountId);if(fingerprint(config)!==approval.snapshot.transportHash)fail('MAIL_ACCOUNT_CHANGED','邮件服务器或账户已改变，原审批不能使用');this._auth(draft.accountId,'smtp');
  this._put('mail_approvals',approvalId,{...approval,status:'approved',decidedAt:now()});this._put('mail_outbox',draft.id,{...draft,status:'approved',updatedAt:now()});
  const controller=new AbortController();const combined=this._signal(signal?AbortSignal.any([controller.signal,signal]):controller.signal);const operation={controller,promise:null};this.active.set(draft.id,operation);
  operation.promise=this._send(draft.id,approval,config,combined).finally(()=>this.active.delete(draft.id));return operation.promise;
 }
 async _send(draftId,approval,config,signal){
  let connection,started=false;let draft=this.store.get('mail_outbox',draftId);this._put('mail_outbox',draftId,{...draft,status:'sending',attempts:draft.attempts+1,phase:'connect',updatedAt:now()});
  try{
   const auth=this._auth(draft.accountId,'smtp');const endpoint=await this._target(config.smtp,signal);if(signal.aborted)throw abortError(signal);
   connection=this.smtpFactory({...config.smtp,...endpoint,requireTLS:!config.smtp.secure,opportunisticTLS:false,logger:false,debug:false,maxResponseSize:65536,connectionTimeout:this.timeoutMs,greetingTimeout:this.timeoutMs,socketTimeout:this.timeoutMs});
   const Composer=require('nodemailer/lib/mail-composer');const raw=await new Promise((resolve,reject)=>new Composer({from:approval.snapshot.from,to:approval.snapshot.to,subject:approval.snapshot.subject,text:approval.snapshot.text,messageId:approval.snapshot.messageId,date:new Date(approval.snapshot.date),disableFileAccess:true,disableUrlAccess:true,newline:'windows'}).compile().build((e,b)=>e?reject(e):resolve(b)));
   const result=await withAbort(new Promise((resolve,reject)=>{
    let settled=false;const finish=(err,info)=>{if(settled)return;settled=true;err?reject(err):resolve(info);};connection.on('error',err=>finish(err));connection.on('end',()=>finish(new MailError('MAIL_DISCONNECTED','邮件连接已断开')));
    connection.connect(()=>{if(signal.aborted)return finish(abortError(signal));if(!connection.secure)return finish(new MailError('MAIL_TLS_REQUIRED','SMTP连接未启用TLS，已阻止认证'));connection.login({user:auth.user,pass:auth.password},err=>{if(err)return finish(err);if(signal.aborted)return finish(abortError(signal));
     let emitted=false;const body=new Readable({read:()=>{if(emitted)return;emitted=true;
      // Nodemailer also drains this stream after an envelope error. Only a positive
      // DATA response indicates bytes may now be delivered to the server.
      if(!settled&&/^[23]\d\d(?:\s|-)/.test(connection.lastServerResponse||'')){started=true;const current=this.store.get('mail_outbox',draftId);this._put('mail_outbox',draftId,{...current,dataStarted:true,phase:'data',updatedAt:now()});}
      body.push(raw);body.push(null);
     }});connection.send({from:approval.snapshot.from,to:approval.snapshot.to,size:raw.length},body,finish);
    });});
   }),signal,()=>connection.close());
   draft=this.store.get('mail_outbox',draftId);const accepted=Array.isArray(result.accepted)?result.accepted:[];if(!accepted.length)fail('MAIL_NOT_ACCEPTED','SMTP未确认任何收件人');
   const saved=this._put('mail_outbox',draftId,{...draft,status:'sent',phase:'confirmed',sentAt:now(),updatedAt:now(),accepted,rejected:result.rejected||[],partial:(result.rejected||[]).length>0,smtpCode:Number(String(result.response||'').slice(0,3))||250,error:null,errorCode:null});this._audit('mail.send.sent',draftId);return saved;
  }catch(error){draft=this.store.get('mail_outbox',draftId);const ambiguous=started||draft.dataStarted;const cancelled=signal.aborted;const code=ambiguous?'MAIL_DELIVERY_UNKNOWN':cancelled?abortError(signal).code:'MAIL_SEND_FAILED';const result=this._put('mail_outbox',draftId,{...draft,status:ambiguous?'unknown':'failed',errorCode:code,error:ambiguous?'DATA已开始，投递结果不确定；禁止自动重试':cancelled?abortError(signal).message:'发送失败；未开始DATA，不会自动重试',updatedAt:now()});this._audit('mail.send.'+result.status,draftId);return result;
  }finally{connection?.close();}
 }
 async cancelSend(draftId){
  const draft=this.store.get('mail_outbox',draftId);if(!draft)fail('MAIL_DRAFT_MISSING','邮件草稿不存在');if(terminal.has(draft.status))return draft;
  const active=this.active.get(draftId);if(active){active.controller.abort();return active.promise;}
  if(draft.approvalId){const approval=this.store.get('mail_approvals',draft.approvalId);if(approval?.status==='pending')this._put('mail_approvals',approval.id,{...approval,status:'cancelled',decidedAt:now()});}
  const result=this._put('mail_outbox',draftId,{...draft,status:'failed',errorCode:'MAIL_CANCELLED',error:'发送前已取消',updatedAt:now()});this._audit('mail.send.cancelled',draftId);return result;
 }
 async close(){this.closed=true;for(const controller of this.readControllers.values())controller.abort();for(const operation of this.active.values())operation.controller.abort();await Promise.allSettled([...this.active.values()].map(x=>x.promise));await Promise.allSettled([...this.inboxLocks.values()]);this.credentials.clear();this.secretHistory.clear();this.getExternalSecrets=()=>[];}
}
