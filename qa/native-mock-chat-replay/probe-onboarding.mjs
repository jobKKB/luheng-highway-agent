// Dependency-free CDP probe. No app source mutation, provider selection or credentials.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const COPY = {
  headers: ["Let's get you setup with Hermes Agent", '开始设置路衡智能体'],
  back: ['Back to sign in', '返回登录'],
  apikey: ['I have an API key', '我有 API 密钥'],
  connect: ['Connect', '连接'],
  placeholder: ['Paste API key', '粘贴 API 密钥'],
};
export function validateEndpoint(value) {
  const u = new URL(value);
  if (u.protocol !== 'ws:' || u.hostname !== '127.0.0.1' || !/^\d+$/.test(u.port)
      || Number(u.port) < 1 || Number(u.port) > 65535 || u.username || u.password || u.search || u.hash
      || !/^\/devtools\/browser\/[a-f0-9-]{36}$/.test(u.pathname)) throw Error('Non-owned loopback CDP endpoint shape');
  return u;
}
export function allowedTarget(raw, installRoot) {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'file:' || u.hostname || u.username || u.password || u.search) return false;
    const actual = decodeURIComponent(u.pathname).replace(/^\//, '').replaceAll('\\', '/').toLowerCase();
    const root = installRoot.replaceAll('\\', '/').replace(/\/$/, '').toLowerCase();
    return [root + '/resources/app.asar.unpacked/dist/index.html', root + '/resources/app.asar/dist/index.html'].includes(actual);
  } catch { return false; }
}
export function chooseTarget(targets, installRoot) {
  const matches = targets.filter(t => t.type === 'page' && allowedTarget(t.url, installRoot));
  if (matches.length !== 1) throw Error(`Expected one exact installed renderer, got ${matches.length}`);
  return matches[0];
}
// Serialized into the installed renderer. Read DOM only, never app stores or credentials.
export function inspectDom(copy, action = null) {
  const visible = e => !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden'
    && Number(getComputedStyle(e).opacity) > 0;
  const norm = s => (s ?? '').replace(/\s+/g, ' ').trim();
  const headers = [...document.querySelectorAll('h2')].filter(e => visible(e) && copy.headers.includes(norm(e.textContent)));
  if (headers.length !== 1) return { mode: 'unsettled', visible_header: false, progressbars: -1, header_count: headers.length };
  const surface = headers[0].closest('[data-glass-opaque]');
  if (!surface || !visible(surface)) return { mode: 'unsettled', visible_header: false, progressbars: -1 };
  const buttons = [...surface.querySelectorAll('button')].filter(visible);
  const find = labels => buttons.filter(e => labels.includes(norm(e.textContent)));
  const back = find(copy.back), apikey = find(copy.apikey), connect = find(copy.connect);
  const passwords = [...surface.querySelectorAll('input[type="password"]')].filter(visible);
  const progressbars = [...surface.querySelectorAll('[role="progressbar"]')].filter(visible).length;
  const form = passwords.length === 1 && passwords[0].value === '' && copy.placeholder.includes(passwords[0].placeholder)
    && connect.length === 1 && connect[0].disabled === true && back.length === 1 && !back[0].disabled && apikey.length === 0;
  const chooser = passwords.length === 0 && back.length === 0 && apikey.length === 1 && !apikey[0].disabled && connect.length === 0;
  const result = { mode: progressbars === 0 ? (form ? 'apikey' : chooser ? 'oauth' : 'unsettled') : 'unsettled',
    visible_header: true, header: norm(headers[0].textContent), progressbars,
    password_inputs: passwords.length, all_passwords_empty: passwords.every(e => e.value === ''),
    connect_disabled: connect.length === 1 && connect[0].disabled, back_buttons: back.length, apikey_buttons: apikey.length,
    text: surface.innerText.slice(0, 50000), url: location.href, title: document.title,
    onboarding_skip: localStorage.getItem('hermes-onboarding-skipped-v1') };
  if (action !== null) {
    if (!['back', 'apikey'].includes(action)) throw Error('Action not permitted');
    if (result.mode !== (action === 'back' ? 'apikey' : 'oauth')) throw Error('Wrong settled mode for action');
    const list = action === 'back' ? back : apikey;
    if (list.length !== 1 || list[0].disabled) throw Error('Action button not unique/enabled');
    const e = list[0]; e.scrollIntoView({block: 'center', inline: 'center', behavior: 'instant'});
    const rect = e.getBoundingClientRect(); const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    if (!hit || !e.contains(hit) || x <= 0 || y <= 0 || x >= innerWidth || y >= innerHeight) throw Error('Action obscured/outside viewport');
    result.click = {x, y, label: norm(e.textContent)};
  }
  return result;
}
export function assertSnapshot(s, mode) {
  if (s.mode !== mode || !s.visible_header || s.progressbars !== 0 || s.onboarding_skip !== null
      || (mode === 'apikey' && (!s.all_passwords_empty || !s.connect_disabled))) throw Error('Settled synthetic onboarding assertion failed');
}

export class CDP {
  constructor(url) { this.url = url; this.pending = new Map(); this.id = 0; this.events = []; }
  async open() {
    this.ws = new WebSocket(this.url);
    this.ws.addEventListener('message', e => {
      const m = JSON.parse(e.data);
      if (m.id) { const p=this.pending.get(m.id); if (!p) return; this.pending.delete(m.id); clearTimeout(p.timer); m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result); }
      else this.events.push(m);
    });
    this.ws.addEventListener('close', () => { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(Error('Owned debugger closed')); } this.pending.clear(); });
    await new Promise((resolve,reject) => { const timer=setTimeout(()=>reject(Error('CDP open deadline')),10000); this.ws.addEventListener('open',()=>{clearTimeout(timer);resolve();},{once:true}); this.ws.addEventListener('error',()=>{clearTimeout(timer);reject(Error('CDP open failed'));},{once:true}); });
  }
  call(method, params={}, sessionId) {
    return new Promise((resolve,reject) => { const id=++this.id; const timer=setTimeout(()=>{this.pending.delete(id);reject(Error(`CDP deadline: ${method}`));},15000); this.pending.set(id,{resolve,reject,timer}); this.ws.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})})); });
  }
  close() { this.ws?.close(); }
}
const sleep = ms => new Promise(r=>setTimeout(r,ms));
export async function main(argv) {
  const [ownershipFile,out,installerSha] = argv;
  if (!ownershipFile || !out || !/^[a-f0-9]{64}$/.test(installerSha??'')) throw Error('Expected owned endpoint receipt, output directory, installer hash');
  if (process.platform !== 'win32' || process.env.GITHUB_ACTIONS !== 'true' || !process.env.RUNNER_TEMP) throw Error('Disposable native Actions runner required');
  const ownedPath = value => path.resolve(value).toLowerCase().startsWith(path.resolve(process.env.RUNNER_TEMP).toLowerCase()+path.sep);
  if (!ownedPath(out) || !ownedPath(ownershipFile)) throw Error('Evidence outside disposable scratch');
  const owner = JSON.parse(fs.readFileSync(ownershipFile,'utf8').replace(/^\uFEFF/,''));
  validateEndpoint(owner.endpoint);
  if (owner.native_job_member !== true || owner.exclusive_loopback_listener !== true || owner.profile_fresh !== true
      || owner.executable.toLowerCase() !== (owner.install_root+'\\LuhengOfficeAgent.exe').toLowerCase()) throw Error('Owned endpoint attestation absent');
  const result = { schema:1, installer_sha256:installerSha, mode:'fresh-synthetic-profile-loopback-cdp',
    accepted_with_declared_limits:false, frontend_settled:false, safe_ui_roundtrips:0, credentials_entered:false,
    model_chat_verified:false, offline_verified:false, physical_ime_verified:false, boot_store_100_percent_verified:false,
    direct_external_renderer_requests:[], snapshots:[], screenshots:[], error:null };
  fs.mkdirSync(out,{recursive:true});
  const cdp = new CDP(owner.endpoint); let session;
  const evaluate = async action => {
    const r=await cdp.call('Runtime.evaluate',{expression:`(${inspectDom.toString()})(${JSON.stringify(COPY)},${JSON.stringify(action??null)})`,returnByValue:true},session);
    if (r.exceptionDetails || !r.result || !('value' in r.result)) throw Error('DOM observation failed');
    const value=r.result.value;
    if(value.url && !allowedTarget(value.url,owner.install_root)) throw Error('Renderer navigated away from admitted installed page');
    return value;
  };
  const waitMode = async (mode,timeout=20000) => {
    const end=Date.now()+timeout; let stable=0,last;
    while(Date.now()<end) { last=await evaluate(); if(last.mode===mode && last.onboarding_skip===null) stable++; else stable=0; if(stable>=3){assertSnapshot(last,mode);return last;} await sleep(600); }
    if(last) result.last_unsettled_snapshot=last;
    throw Error(`Frontend did not settle to ${mode} before bounded deadline`);
  };
  const capture = async (name,s) => {
    const shot=await cdp.call('Page.captureScreenshot',{format:'png',fromSurface:true,captureBeyondViewport:false},session);
    const data=Buffer.from(shot.data,'base64'); if(data.length<1024 || data.length>32*1024*1024) throw Error('Unexpected screenshot size');
    fs.writeFileSync(path.join(out,name),data); result.screenshots.push({path:name,bytes:data.length,sha256:createHash('sha256').update(data).digest('hex')});
    result.snapshots.push({...s,stage:name.replace('.png','')});
  };
  const click = async action => {
    const s=await evaluate(action); if(!s.click) throw Error('Safe click coordinates unavailable');
    await cdp.call('Input.dispatchMouseEvent',{type:'mousePressed',x:s.click.x,y:s.click.y,button:'left',clickCount:1},session);
    await cdp.call('Input.dispatchMouseEvent',{type:'mouseReleased',x:s.click.x,y:s.click.y,button:'left',clickCount:1},session);
  };
  try {
    await cdp.open();
    // This single socket is never reconnected or retargeted to another browser.
    const targetDeadline=Date.now()+30000; let target;
    while(Date.now()<targetDeadline) {
      const {targetInfos}=await cdp.call('Target.getTargets');
      const matches=targetInfos.filter(t=>t.type==='page' && allowedTarget(t.url,owner.install_root));
      if(matches.length>1) throw Error('Multiple exact installed renderer targets');
      if(matches.length===1) { target=chooseTarget(targetInfos,owner.install_root); break; }
      await sleep(500);
    }
    if(!target) throw Error('Installed renderer target did not appear before deadline');
    result.target={id:target.targetId,url:target.url};
    ({sessionId:session}=await cdp.call('Target.attachToTarget',{targetId:target.targetId,flatten:true}));
    await cdp.call('Runtime.enable',{},session); await cdp.call('Page.enable',{},session); await cdp.call('Network.enable',{},session);
    const first=await waitMode('apikey',180000); result.frontend_settled=true; await capture('onboarding-initial-settled.png',first);
    for(let i=1;i<=2;i++) {
      await click('back'); await capture(`onboarding-chooser-${i}.png`,await waitMode('oauth'));
      await click('apikey'); await capture(`onboarding-return-${i}.png`,await waitMode('apikey'));
      result.safe_ui_roundtrips++;
    }
    result.direct_external_renderer_requests=cdp.events.filter(e=>e.method==='Network.requestWillBeSent'&&e.sessionId===session).flatMap(e=>{
      const u=new URL(e.params.request.url);return ['http:','https:','ws:','wss:'].includes(u.protocol)&&!['127.0.0.1','localhost','[::1]'].includes(u.hostname)?[{method:e.params.request.method,origin:u.origin,pathname:u.pathname}]:[];
    });
    if(result.direct_external_renderer_requests.length) throw Error('Unexpected direct external renderer request observed');
    result.accepted_with_declared_limits=true;
  } catch(e) {
    result.error=String(e?.message??e);
    if(session) { try { await capture('onboarding-failure.png',await evaluate()); } catch(e2) { result.failure_capture_error=String(e2?.message??e2); } }
  } finally {
    cdp.close(); fs.writeFileSync(path.join(out,'onboarding-ui.json'),JSON.stringify(result,null,2)+'\n');
  }
  if(!result.accepted_with_declared_limits) throw Error(result.error);
  return result;
}
if (process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const watchdog=setTimeout(()=>{ console.error('Overall UI probe deadline exceeded');process.exit(2); },270000);
  try { await main(process.argv.slice(2)); } catch(e) { console.error(e.message); process.exitCode=1; } finally {clearTimeout(watchdog);}
}
