// Native acceptance hook: real installed renderer -> backend -> local mock -> read_file -> renderer.
import fs from 'node:fs';
import path from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {DUMMY_KEY,MODEL,startMockProvider} from './mock-provider.mjs';

export const EXPECTED_INSTALLER_SHA='e510b8d17bd8145f1fcbfe5ab3e57070988b1b62f6d9c6e1f169233de1dd080f';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const normalize=p=>path.resolve(p).replaceAll('\\','/').toLowerCase();
const inside=(p,root)=>normalize(p).startsWith(normalize(root).replace(/\/$/,'')+'/');

export async function waitForInstalledTarget(cdp,installRoot,{chooseTarget,allowedTarget},timeoutMs=30000,intervalMs=300){
  const end=Date.now()+timeoutMs;
  do {
    const {targetInfos}=await cdp.call('Target.getTargets');
    const matches=targetInfos.filter(t=>t.type==='page'&&allowedTarget(t.url,installRoot));
    // One owned socket only. Retry zero targets while the installed window navigates;
    // ambiguous targets fail immediately and never select another app/browser.
    if(matches.length>0)return chooseTarget(targetInfos,installRoot);
    if(Date.now()>=end)break;
    await sleep(Math.min(intervalMs,Math.max(0,end-Date.now())));
  }while(Date.now()<=end);
  throw Error('Bounded timeout: exact installed renderer target');
}

// Observation and hit testing only. No stores, module imports, DOM text injection or synthetic replies.
export function inspectMockDom(action, expected) {
  const visible=e=>!!e&&e.getClientRects().length>0&&getComputedStyle(e).visibility!=='hidden'&&Number(getComputedStyle(e).opacity)>0;
  const norm=s=>(s??'').replace(/\s+/g,' ').trim();
  const headers=[...document.querySelectorAll('h2')].filter(e=>visible(e)&&["Let's get you setup with Hermes Agent",'开始设置路衡智能体'].includes(norm(e.textContent)));
  const surface=headers.length===1?headers[0].closest('[data-glass-opaque]'):null;
  const buttons=[...(surface??document).querySelectorAll('button')].filter(visible);
  const local=buttons.filter(e=>[...e.querySelectorAll('span')].some(s=>['Local / custom endpoint','本地 / 自定义端点'].includes(norm(s.textContent))));
  const url=surface?[...surface.querySelectorAll('input[type="text"]')].filter(e=>visible(e)&&e.placeholder==='http://127.0.0.1:8000/v1'):[];
  const keys=surface?[...surface.querySelectorAll('input[type="password"]')].filter(visible):[];
  const connect=buttons.filter(e=>['Connect','连接'].includes(norm(e.textContent)));
  const composers=[...document.querySelectorAll('[data-slot="composer-rich-input"][contenteditable="true"]')].filter(visible);
  const sends=[...document.querySelectorAll('button[type="submit"]')].filter(e=>visible(e)&&['Send','发送'].includes(e.getAttribute('aria-label')));
  const stop=[...document.querySelectorAll('button')].filter(e=>visible(e)&&['Stop','停止'].includes(e.getAttribute('aria-label')));
  const assistant=[...document.querySelectorAll('[data-role="assistant"] [data-slot="aui_assistant-message-content"]')].filter(visible);
  const user=[...document.querySelectorAll('[data-role="user"]')].filter(visible);
  const state={onboarding_visible:!!surface&&visible(surface),local_option_count:local.length,url_input_count:url.length,
    password_input_count:keys.length,fields_empty:url.every(e=>e.value==='')&&keys.every(e=>e.value===''),
    synthetic_endpoint_matches:url.length===1&&url[0].value===expected.baseUrl,
    synthetic_key_matches:keys.length===1&&keys[0].value===expected.dummyKey,
    connect_enabled:connect.length===1&&!connect[0].disabled,
    composer_count:composers.length,composer_empty:composers.length===1&&norm(composers[0].innerText)==='',
    prompt_in_composer:composers.length===1&&composers[0].innerText.includes(expected.prompt),
    user_prompt_rendered:user.some(e=>e.innerText.includes(expected.prompt)),
    assistant_reply_rendered:assistant.some(e=>e.innerText.includes(expected.finalText)),
    send_enabled:sends.length===1&&!sends[0].disabled,stop_visible:stop.length>0};
  if(action) {
    let list;
    if(action==='local') {if(!state.onboarding_visible)throw Error('Onboarding absent');list=local;}
    else if(action==='url') {if(!state.fields_empty)throw Error('Unexpected populated provider fields');list=url;}
    else if(action==='key') {if(!state.synthetic_endpoint_matches||keys.some(e=>e.value!==''))throw Error('Unexpected provider field state');list=keys;}
    else if(action==='connect') {if(!state.synthetic_endpoint_matches||!state.synthetic_key_matches)throw Error('Provider configuration mismatch');list=connect;}
    else if(action==='composer') {if(state.onboarding_visible||!state.composer_empty)throw Error('Composer is not a fresh draft');list=composers;}
    else if(action==='send') {if(!state.prompt_in_composer||state.onboarding_visible)throw Error('Unexpected prompt state');list=sends;}
    else throw Error('Unapproved UI action');
    if(list.length!==1||list[0].disabled)throw Error('Action target ambiguous or disabled');
    const e=list[0];e.scrollIntoView({block:'center',inline:'center',behavior:'instant'});
    const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);
    if(!hit||!e.contains(hit)||x<=0||y<=0||x>=innerWidth||y>=innerHeight)throw Error('Action target obscured');
    state.click={x,y};
  }
  return state;
}

export async function main(argv) {
  const [ownershipFile,out,installerSha,stateRoot,probeModule]=argv;
  if(process.platform!=='win32'||process.env.GITHUB_ACTIONS!=='true'||!process.env.RUNNER_TEMP)throw Error('Disposable hosted Windows runner required');
  if(installerSha!==EXPECTED_INSTALLER_SHA)throw Error('Exact immutable installer hash required');
  for(const p of [ownershipFile,out,stateRoot,probeModule])if(!p||!path.isAbsolute(p))throw Error('Absolute local harness paths required');
  const owner=JSON.parse(fs.readFileSync(ownershipFile,'utf8').replace(/^\uFEFF/,''));
  if(!inside(stateRoot,process.env.RUNNER_TEMP)||!inside(out,process.env.RUNNER_TEMP)
    ||!inside(owner.install_root,process.env.RUNNER_TEMP)||!inside(owner.profile,stateRoot)
    ||normalize(owner.profile)!==normalize(path.join(stateRoot,'electron-user-data'))
    ||owner.native_job_member!==true||owner.exclusive_loopback_listener!==true||owner.profile_fresh!==true
    ||normalize(owner.executable)!==normalize(path.join(owner.install_root,'LuhengOfficeAgent.exe')))throw Error('Fresh isolated native ownership required');
  const {CDP,validateEndpoint,chooseTarget,allowedTarget}=await import(pathToFileURL(probeModule).href);
  if(typeof CDP!=='function')throw Error('Reviewed onboarding CDP client export required');
  validateEndpoint(owner.endpoint);
  const workRoot=path.join(stateRoot,'work');
  if(!fs.statSync(workRoot).isDirectory()||fs.lstatSync(workRoot).isSymbolicLink())throw Error('Owned work directory absent or linked');
  // A unique owned directory is created, never an existing marker or user file overwritten.
  const nonce=randomBytes(16).toString('hex'),fixtureRoot=path.join(workRoot,`mock-acceptance-${nonce}`);
  fs.mkdirSync(fixtureRoot);
  const markerPath=path.join(fixtureRoot,'owned-marker.txt'),markerText=`LUHENG_READ_MARKER_${randomBytes(16).toString('hex')}`;
  fs.writeFileSync(markerPath,markerText+'\n',{flag:'wx'});
  fs.mkdirSync(out,{recursive:true});
  const result={schema:1,kind:'mocked-model-orchestration',installer_sha256:installerSha,
    accepted_with_declared_limits:false,provider_setup_route:'onboarding-local-endpoint-ui',
    title_generation_disabled:false,synthetic_key_only:true,local_model_request_verified:false,
    real_read_file_roundtrip_verified:false,assistant_reply_rendered:false,
    real_provider_verified:false,llm_quality_verified:false,offline_verified:false,
    physical_ime_verified:false,os_network_settings_changed:false,screenshots:[],snapshots:[],error:null};
  const cdp=new CDP(owner.endpoint);let session,mock;
  const evaluate=async expression=>{
    const r=await cdp.call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},session);
    if(r.exceptionDetails||!r.result||!('value'in r.result))throw Error('Installed renderer observation/action failed');
    return r.result.value;
  };
  const expected=()=>({baseUrl:mock.baseUrl,dummyKey:DUMMY_KEY,prompt:mock.prompt,finalText:mock.finalText});
  const inspect=action=>evaluate(`(${inspectMockDom.toString()})(${JSON.stringify(action??null)},${JSON.stringify(expected())})`);
  const waitFor=async(predicate,label,timeout=30000)=>{
    const end=Date.now()+timeout;let stable=0,last;
    while(Date.now()<end){if(mock.state.failure)throw Error(`Mock rejected request: ${mock.state.failure}`);last=await inspect();stable=predicate(last)?stable+1:0;if(stable>=3)return last;await sleep(600);}
    result.last_observation=last;throw Error(`Bounded timeout: ${label}`);
  };
  const click=async action=>{const s=await inspect(action);for(const type of ['mousePressed','mouseReleased'])await cdp.call('Input.dispatchMouseEvent',{type,...s.click,button:'left',clickCount:1},session);};
  const capture=async(name,s)=>{
    const shot=await cdp.call('Page.captureScreenshot',{format:'png',fromSurface:true,captureBeyondViewport:false},session);
    const data=Buffer.from(shot.data,'base64');if(data.length<1024||data.length>32*1024*1024)throw Error('Screenshot bounds failed');
    fs.writeFileSync(path.join(out,name),data);result.screenshots.push({path:name,bytes:data.length,sha256:createHash('sha256').update(data).digest('hex')});
    result.snapshots.push({stage:name,...s});
  };
  try {
    mock=await startMockProvider({markerPath,markerText,nonce});
    result.loopback={address:'127.0.0.1',port:mock.port,owner_pid:process.pid,ephemeral:true};
    await cdp.open();
    const target=await waitForInstalledTarget(cdp,owner.install_root,{chooseTarget,allowedTarget});
    ({sessionId:session}=await cdp.call('Target.attachToTarget',{targetId:target.targetId,flatten:true}));
    result.target={id:target.targetId,url:target.url};
    await cdp.call('Runtime.enable',{},session);await cdp.call('Page.enable',{},session);await cdp.call('Network.enable',{},session);
    // Use the app's supported config API; a partial PUT deep-merges on the backend.
    // Read back only safety-related synthetic facts, never key values or the full config.
    const scope=await evaluate(`(async()=>{const c=await window.hermesDesktop.api({path:'/api/config'});return {cwd:c.terminal?.cwd,titleDisabled:c.auxiliary?.title_generation?.enabled===false,telemetryDisabled:c.telemetry?.shared_metrics?.enabled===false}})()`);
    if(normalize(scope.cwd??'')!==normalize(workRoot)||scope.telemetryDisabled!==true)throw Error('Backend config is not the disposable work profile');
    const saved=await evaluate(`window.hermesDesktop.api({path:'/api/config',method:'PUT',body:{config:{auxiliary:{title_generation:{enabled:false,model_upgrade_enabled:false}}}}})`);
    if(saved?.ok!==true)throw Error('Could not disable synthetic background title calls');
    result.title_generation_disabled=await evaluate(`(async()=>{const c=await window.hermesDesktop.api({path:'/api/config'});return c.auxiliary?.title_generation?.enabled===false&&c.auxiliary?.title_generation?.model_upgrade_enabled===false})()`);
    if(!result.title_generation_disabled)throw Error('Title-call config readback failed');
    await waitFor(s=>s.onboarding_visible&&s.local_option_count===1,'initial local-endpoint choice');
    await click('local');await waitFor(s=>s.url_input_count===1&&s.password_input_count===1&&s.fields_empty,'empty local-endpoint form');
    await click('url');await cdp.call('Input.insertText',{text:mock.baseUrl},session);
    await click('key');await cdp.call('Input.insertText',{text:DUMMY_KEY},session);
    await capture('mock-provider-configured.png',await waitFor(s=>s.synthetic_endpoint_matches&&s.synthetic_key_matches&&s.connect_enabled,'synthetic provider form'));
    await click('connect');
    await waitFor(s=>!s.onboarding_visible&&s.composer_count===1&&s.composer_empty,'connected fresh chat',90000);
    await click('composer');await cdp.call('Input.insertText',{text:mock.prompt},session);
    await waitFor(s=>s.prompt_in_composer&&s.send_enabled,'synthetic prompt ready');await click('send');
    const done=await waitFor(s=>mock.state.stage===2&&mock.state.marker_verified&&s.user_prompt_rendered&&s.assistant_reply_rendered&&!s.stop_visible,'real tool roundtrip and rendered mock reply',120000);
    await capture('mock-chat-tool-roundtrip.png',done);
    result.local_model_request_verified=mock.state.model_requests===2;
    result.real_read_file_roundtrip_verified=mock.state.marker_verified;
    result.assistant_reply_rendered=done.assistant_reply_rendered;
    result.direct_external_renderer_request_count=cdp.events.filter(e=>e.method==='Network.requestWillBeSent'&&e.sessionId===session).filter(e=>{
      try{const u=new URL(e.params.request.url);return ['http:','https:','ws:','wss:'].includes(u.protocol)&&!['127.0.0.1','localhost','[::1]'].includes(u.hostname);}catch{return true;}
    }).length;
    if(result.direct_external_renderer_request_count)throw Error('Unexpected external renderer traffic observed');
    if(!result.local_model_request_verified||mock.state.rejected_requests)throw Error('Mock protocol acceptance incomplete');
    result.accepted_with_declared_limits=true;
  } catch(e) {
    // Error messages are harness-authored; external exception strings are not persisted.
    result.error=/^(Mock rejected request:|Bounded timeout:|Installed renderer|Fresh isolated|Backend config|Could not disable|Title-call|Unexpected external|Mock protocol|Screenshot)/.test(String(e.message))?e.message:'Native mock acceptance failed; inspect bounded stage flags';
    if(session&&mock){try{await capture('mock-chat-failure.png',await inspect());}catch{result.failure_capture_failed=true;}}
  } finally {
    cdp.close();
    if(mock){await mock.close();result.protocol=mock.state;result.loopback.closed=true;}
    result.marker_file_unchanged=fs.readFileSync(markerPath,'utf8')===markerText+'\n';
    if(!result.marker_file_unchanged){result.accepted_with_declared_limits=false;result.error='Owned marker unexpectedly changed';}
    fs.writeFileSync(path.join(out,'mock-chat.json'),JSON.stringify(result,null,2)+'\n');
  }
  if(!result.accepted_with_declared_limits)throw Error(result.error);
  return result;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const timer=setTimeout(()=>{console.error('Native mock acceptance deadline exceeded');process.exit(2);},300000);
  try{await main(process.argv.slice(2));}catch(e){console.error(e.message);process.exitCode=1;}finally{clearTimeout(timer);}
}
