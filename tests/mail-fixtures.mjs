import tls from 'node:tls';
import net from 'node:net';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
export const TEST_PASSWORD='fabricated-mail-password-83';
export const TEST_USER='sender@example.invalid';
export function message(uid,text='Fabricated inbound message '+uid){return Buffer.from(`From: fixture@example.invalid\r\nTo: sender@example.invalid\r\nSubject: Fixture ${uid}\r\nMessage-ID: <fixture-${uid}@example.invalid>\r\nDate: Thu, 01 Oct 2026 10:00:00 +0000\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(text).toString('base64')}\r\n`);}
async function listen(server){await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});return server.address().port;}
function selected(range,uid){return range.split(',').some(part=>{const [a,b=a]=part.split(':').map(Number);return uid>=a&&uid<=b;});}
export async function mailFixtures(){
 const dir=await mkdtemp(join(tmpdir(),'mail-fixture-cert-'));const keyPath=join(dir,'key.pem'),certPath=join(dir,'cert.pem');
 await exec('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-keyout',keyPath,'-out',certPath,'-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1,DNS:localhost']);
 const key=await readFile(keyPath),cert=await readFile(certPath);const sockets=new Set();
 const smtp={mode:'normal',connections:0,commands:[],messages:[],dataCommands:0,authenticated:0};
 const handleSmtp=(socket,sendGreeting=true)=>{
  sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{});smtp.connections++;let buffer='',inData=false,envelope={from:'',to:[]};
  if(sendGreeting&&smtp.mode!=='no-greeting')socket.write('220 fixture.example.invalid ESMTP\r\n');
  socket.on('data',chunk=>{buffer+=chunk.toString();while(buffer.includes('\r\n')){
   if(inData){const end=buffer.indexOf('\r\n.\r\n');if(end<0)return;const raw=buffer.slice(0,end+2).replace(/^\.\./gm,'.');buffer=buffer.slice(end+5);inData=false;smtp.messages.push({raw,envelope:structuredClone(envelope)});if(smtp.mode==='drop-after-data'){socket.destroy();return;}if(smtp.mode==='hold-after-data')return;socket.write('250 2.0.0 accepted fixture-id\r\n');continue;}
   const end=buffer.indexOf('\r\n'),line=buffer.slice(0,end);buffer=buffer.slice(end+2);smtp.commands.push(line);const upper=line.toUpperCase();
   if(upper.startsWith('EHLO')||upper.startsWith('HELO'))socket.write('250-fixture.example.invalid\r\n250-AUTH PLAIN LOGIN\r\n250 SIZE 1000000\r\n');
   else if(upper.startsWith('AUTH PLAIN')){const credentials=Buffer.from(line.split(' ')[2]||'','base64').toString();if(smtp.mode==='reject-auth'||!credentials.endsWith('\0'+TEST_PASSWORD))socket.write('535 denied '+TEST_PASSWORD+'\r\n');else{smtp.authenticated++;socket.write('235 2.7.0 authenticated\r\n');}}
   else if(upper.startsWith('MAIL FROM:')){envelope={from:line.match(/<([^>]*)>/)?.[1]||'',to:[]};socket.write('250 sender accepted\r\n');}
   else if(upper.startsWith('RCPT TO:')){if(smtp.mode==='reject-recipient')socket.write('550 recipient unavailable\r\n');else{envelope.to.push(line.match(/<([^>]*)>/)?.[1]||'');socket.write('250 recipient accepted\r\n');}}
   else if(upper==='DATA'){smtp.dataCommands++;if(smtp.mode!=='hold-before-data'){inData=true;socket.write('354 send message\r\n');}}
   else if(upper==='QUIT'){socket.end('221 bye\r\n');}
   else if(upper==='RSET')socket.write('250 reset\r\n');
   else socket.write('500 unsupported fixture command\r\n');
  }});
 };const smtpServer=tls.createServer({key,cert},socket=>handleSmtp(socket));smtpServer.on('tlsClientError',()=>{});const smtpPort=await listen(smtpServer);
 const imap={uidValidity:41,messages:[{uid:1,raw:message(1)},{uid:2,raw:message(2)}],commands:[],mode:'normal',connections:0,authenticated:0};
 const handleImap=(socket,sendGreeting=true)=>{
  sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{});imap.connections++;let buffer='',challengeTag;
  if(sendGreeting&&imap.mode!=='no-greeting')socket.write('* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN SASL-IR] fixture ready\r\n');
  const authenticate=(tag,base64)=>{const decoded=Buffer.from(base64,'base64').toString();if(imap.mode==='reject-auth'||!decoded.endsWith('\0'+TEST_PASSWORD))socket.write(`${tag} NO authentication denied ${TEST_PASSWORD}\r\n`);else{imap.authenticated++;socket.write(`${tag} OK authenticated\r\n`);}};
  socket.on('data',chunk=>{buffer+=chunk.toString();while(buffer.includes('\r\n')){const end=buffer.indexOf('\r\n'),line=buffer.slice(0,end);buffer=buffer.slice(end+2);imap.commands.push(line);if(challengeTag){authenticate(challengeTag,line);challengeTag=null;continue;}
   const split=line.indexOf(' '),tag=line.slice(0,split),command=line.slice(split+1),upper=command.toUpperCase();
   if(upper==='CAPABILITY')socket.write(`* CAPABILITY IMAP4rev1 AUTH=PLAIN SASL-IR\r\n${tag} OK capability\r\n`);
   else if(upper.startsWith('AUTHENTICATE PLAIN')){const initial=command.split(' ')[2];if(initial)authenticate(tag,initial);else{challengeTag=tag;socket.write('+ \r\n');}}
   else if(upper.startsWith('LOGIN '))authenticate(tag,Buffer.from('\0'+TEST_USER+'\0'+TEST_PASSWORD).toString('base64'));
   else if(upper.startsWith('LIST ')||upper.startsWith('LSUB '))socket.write(`* LIST (\\HasNoChildren) "/" "INBOX"\r\n${tag} OK list\r\n`);
   else if(upper.startsWith('EXAMINE ')||upper.startsWith('SELECT ')){const next=Math.max(0,...imap.messages.map(x=>x.uid))+1;socket.write(`* FLAGS (\\Seen)\r\n* ${imap.messages.length} EXISTS\r\n* 0 RECENT\r\n* OK [UIDVALIDITY ${imap.uidValidity}] stable\r\n* OK [UIDNEXT ${next}] next\r\n${tag} OK [READ-ONLY] examined\r\n`);}
   else if(upper.startsWith('UID SEARCH ')){if(imap.mode==='hold-search')continue;const range=command.match(/UID (\d+:\d+)/i)?.[1]||'1:999999';const found=imap.messages.filter(x=>selected(range,x.uid)).map(x=>x.uid);socket.write(`* SEARCH ${found.join(' ')}\r\n${tag} OK search\r\n`);}
   else if(upper.startsWith('UID FETCH ')){const range=command.split(' ')[2];for(const [index,row] of imap.messages.entries())if(selected(range,row.uid)){const raw=row.raw.subarray(0,65536);socket.write(`* ${index+1} FETCH (UID ${row.uid} FLAGS () RFC822.SIZE ${row.raw.length} BODY[]<0> {${raw.length}}\r\n`);socket.write(raw);socket.write(')\r\n');}socket.write(`${tag} OK fetch\r\n`);}
   else if(upper==='LOGOUT')socket.end(`* BYE logout\r\n${tag} OK logout\r\n`);
   else if(upper==='NOOP')socket.write(`${tag} OK noop\r\n`);
   else socket.write(`${tag} BAD unsupported fixture command\r\n`);
  }});
 };const imapServer=tls.createServer({key,cert},socket=>handleImap(socket));imapServer.on('tlsClientError',()=>{});const imapPort=await listen(imapServer);
 const starttls=(kind,handler)=>net.createServer(socket=>{
  sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{});let buffer='';
  socket.write(kind==='smtp'?'220 fixture STARTTLS ready\r\n':'* OK [CAPABILITY IMAP4rev1 STARTTLS LOGINDISABLED] fixture ready\r\n');
  const receive=chunk=>{buffer+=chunk.toString();while(buffer.includes('\r\n')){const end=buffer.indexOf('\r\n'),line=buffer.slice(0,end);buffer=buffer.slice(end+2);(kind==='smtp'?smtp:imap).commands.push('PRETLS:'+line);const tag=line.split(' ')[0];
   if(kind==='smtp'&&/^EHLO /i.test(line))socket.write('250-fixture\r\n250 STARTTLS\r\n');
   else if(kind==='imap'&&/ CAPABILITY$/i.test(line))socket.write('* CAPABILITY IMAP4rev1 STARTTLS LOGINDISABLED\r\n'+tag+' OK capability\r\n');
   else if((kind==='smtp'&&line==='STARTTLS')||(kind==='imap'&&/ STARTTLS$/.test(line))){socket.write(kind==='smtp'?'220 upgrade\r\n':tag+' OK upgrade\r\n');socket.removeListener('data',receive);const upgraded=new tls.TLSSocket(socket,{isServer:true,secureContext:tls.createSecureContext({key,cert})});upgraded.on('error',()=>{});upgraded.once('secure',()=>handler(upgraded,false));return;}
   else socket.write(kind==='smtp'?'530 TLS required\r\n':tag+' NO TLS required\r\n');
  }};socket.on('data',receive);
 });
 const smtpStarttls=starttls('smtp',handleSmtp),imapStarttls=starttls('imap',handleImap);const smtpStarttlsPort=await listen(smtpStarttls),imapStarttlsPort=await listen(imapStarttls);
 return {smtp,imap,cert,starttlsPorts:{smtp:smtpStarttlsPort,imap:imapStarttlsPort},config:{accountId:'fixture',from:TEST_USER,imap:{host:'127.0.0.1',port:imapPort,secure:true,user:TEST_USER,password:TEST_PASSWORD},smtp:{host:'127.0.0.1',port:smtpPort,secure:true,user:TEST_USER,password:TEST_PASSWORD}},async close(){for(const socket of sockets)socket.destroy();await Promise.all([new Promise(r=>smtpServer.close(r)),new Promise(r=>imapServer.close(r)),new Promise(r=>smtpStarttls.close(r)),new Promise(r=>imapStarttls.close(r))]);await rm(dir,{recursive:true,force:true});}};
}
