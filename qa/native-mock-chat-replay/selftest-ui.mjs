import test from 'node:test';
import assert from 'node:assert/strict';
import {validateEndpoint,allowedTarget,chooseTarget,assertSnapshot,inspectDom,COPY} from './probe-onboarding.mjs';
const root='D:\\a\\_temp\\luheng-onboarding-ui\\isolated-install';
const target='file:///D:/a/_temp/luheng-onboarding-ui/isolated-install/resources/app.asar.unpacked/dist/index.html#/';
test('endpoint admits only exact loopback browser WebSocket',()=>{
  assert.equal(validateEndpoint('ws://127.0.0.1:49152/devtools/browser/11111111-2222-3333-4444-555555555555').port,'49152');
  for(const x of ['wss://127.0.0.1:49152/devtools/browser/11111111-2222-3333-4444-555555555555','ws://localhost:49152/devtools/browser/11111111-2222-3333-4444-555555555555','ws://0.0.0.0:49152/devtools/browser/11111111-2222-3333-4444-555555555555','ws://127.0.0.1:49152/devtools/page/x','ws://user@127.0.0.1:49152/devtools/browser/11111111-2222-3333-4444-555555555555','ws://127.0.0.1:49152/devtools/browser/11111111-2222-3333-4444-555555555555?q=1']) assert.throws(()=>validateEndpoint(x));
});
test('target pins exact installed main renderer and excludes overlays, external and foreign files',()=>{
  assert.equal(allowedTarget(target,root),true);
  for(const x of [target.replace('.unpacked',''),target.replace('D:','d:')])assert.equal(allowedTarget(x,root),true);
  for(const x of ['https://localhost/index.html',target.replace('isolated-install','foreign'),target.replace('#/','?win=overlay#/'),target.replace('#/','?win=quick#/'),'file://foreign/D:/index.html',target.replace('index.html','other.html')])assert.equal(allowedTarget(x,root),false);
  assert.throws(()=>chooseTarget([],root)); assert.throws(()=>chooseTarget([{type:'page',url:target},{type:'page',url:target}],root));
});
test('settled assertion rejects progress, nonempty credential and persisted skip',()=>{
  const s={mode:'apikey',visible_header:true,progressbars:0,onboarding_skip:null,all_passwords_empty:true,connect_disabled:true};
  assert.doesNotThrow(()=>assertSnapshot(s,'apikey'));
  for(const patch of [{mode:'unsettled'},{progressbars:1},{visible_header:false},{onboarding_skip:'1'},{all_passwords_empty:false},{connect_disabled:false}])assert.throws(()=>assertSnapshot({...s,...patch},'apikey'));
});
// Tiny DOM fixture exercises actual serialized selector logic, not a native browser claim.
function fixture(mode,locale=0) {
  const mk=(text='',extra={})=>({textContent:text,getClientRects:()=>[{}],...extra});
  const input=mk('',{value:'',placeholder:COPY.placeholder[locale]});
  const back=mk(COPY.back[locale],{disabled:false}); const api=mk(COPY.apikey[locale],{disabled:false});
  const connect=mk(COPY.connect[locale],{disabled:true});
  const buttons=mode==='apikey'?[back,connect]:[api];
  const surface=mk('',{innerText:'synthetic onboarding',querySelectorAll:s=>s==='button'?buttons:s==='input[type="password"]'?(mode==='apikey'?[input]:[]):[]});
  const heading=mk(COPY.headers[locale],{closest:()=>surface});
  for(const b of buttons)Object.assign(b,{scrollIntoView(){},getBoundingClientRect:()=>({x:10,y:20,width:100,height:30}),contains:e=>e===b});
  globalThis.document={querySelectorAll:()=>[heading],elementFromPoint:()=>mode==='apikey'?back:api,title:'Synthetic'};
  globalThis.getComputedStyle=()=>({visibility:'visible',opacity:'1'});globalThis.location={href:target};
  globalThis.localStorage={getItem:()=>null};globalThis.innerWidth=800;globalThis.innerHeight=600;
  return {surface,input,connect,buttons};
}
test('source-grounded English and Chinese forms resolve and safe actions find unobscured centers',()=>{
  for(const locale of [0,1])for(const mode of ['apikey','oauth']) {
    fixture(mode,locale);const s=inspectDom(COPY);assert.equal(s.mode,mode);assertSnapshot(s,mode);
    assert.equal(inspectDom(COPY,mode==='apikey'?'back':'apikey').click.x,60);
    assert.throws(()=>inspectDom(COPY,'connect'));
  }
});
test('DOM rejects visible boot progress, enabled save, duplicate or obscured safe action',()=>{
  let f=fixture('apikey');const q=f.surface.querySelectorAll;f.surface.querySelectorAll=s=>s==='[role="progressbar"]'?[{getClientRects:()=>[{}]}]:q(s);assert.equal(inspectDom(COPY).mode,'unsettled');
  f=fixture('apikey');f.connect.disabled=false;assert.equal(inspectDom(COPY).mode,'unsettled');
  f=fixture('apikey');f.input.value='synthetic';assert.equal(inspectDom(COPY).mode,'unsettled');
  fixture('apikey');globalThis.document.elementFromPoint=()=>({});assert.throws(()=>inspectDom(COPY,'back'));
});

test('built-in WebSocket transports actual masked CDP requests over synthetic loopback',async()=>{
  const {createServer}=await import('node:http');const {createHash}=await import('node:crypto');
  const {CDP}=await import('./probe-onboarding.mjs');
  const server=createServer();const sockets=new Set();const calls=[];
  server.on('upgrade',(req,socket)=>{
    sockets.add(socket);socket.on('close',()=>sockets.delete(socket));
    const accept=createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');
    let buffer=Buffer.alloc(0);
    socket.on('data',chunk=>{
      buffer=Buffer.concat([buffer,chunk]);
      while(buffer.length>=6){
        const op=buffer[0]&15;if(op===8){socket.end();return;}
        let size=buffer[1]&127,offset=2;if(size===126){if(buffer.length<8)return;size=buffer.readUInt16BE(2);offset=4;}if(size===127)throw Error('Unexpected large selftest frame');
        if(buffer.length<offset+4+size)return;const mask=buffer.subarray(offset,offset+4);offset+=4;
        const payload=Buffer.from(buffer.subarray(offset,offset+size));for(let i=0;i<payload.length;i++)payload[i]^=mask[i%4];buffer=buffer.subarray(offset+size);
        const m=JSON.parse(payload);calls.push(m);const reply=Buffer.from(JSON.stringify(m.method==='fail'?{id:m.id,error:{message:'synthetic-denied'}}:{id:m.id,result:{targetInfos:[]}}));
        assert.ok(reply.length<126);socket.write(Buffer.concat([Buffer.from([0x81,reply.length]),reply]));
      }
    });
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const cdp=new CDP(`ws://127.0.0.1:${server.address().port}/devtools/browser/11111111-2222-3333-4444-555555555555`);
  try {await cdp.open();assert.deepEqual(await cdp.call('Target.getTargets'),{targetInfos:[]});await assert.rejects(cdp.call('fail'),/synthetic-denied/);assert.equal(calls[0].method,'Target.getTargets');}
  finally{cdp.close();for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));}
});
