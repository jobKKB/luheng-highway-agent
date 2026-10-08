import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {EXPECTED_INSTALLER_SHA} from './probe-mock-chat.mjs';

export function verifyReceipt(r) {
  const require=(ok,message)=>{if(!ok)throw Error(message);};
  require(r?.schema===1&&r.kind==='mocked-model-orchestration','Wrong mock evidence schema');
  require(r.installer_sha256===EXPECTED_INSTALLER_SHA,'Installer pin is not reviewed baseline');
  require(r.accepted_with_declared_limits===true&&!r.error,'Mock acceptance failed/incomplete');
  for(const name of ['title_generation_disabled','synthetic_key_only','local_model_request_verified',
    'real_read_file_roundtrip_verified','assistant_reply_rendered','marker_file_unchanged'])require(r[name]===true,`Missing ${name}`);
  for(const name of ['real_provider_verified','llm_quality_verified','offline_verified','physical_ime_verified','os_network_settings_changed'])require(r[name]===false,`Overclaimed ${name}`);
  require(r.provider_setup_route==='onboarding-local-endpoint-ui','Provider route changed');
  require(r.loopback?.address==='127.0.0.1'&&r.loopback.ephemeral===true&&r.loopback.closed===true&&r.loopback.port>0&&r.loopback.port<=65535,'Loopback lifecycle incomplete');
  require(r.direct_external_renderer_request_count===0,'External renderer traffic observed/unreported');
  const p=r.protocol;
  require(p?.stage===2&&p.model_requests===2&&p.marker_verified===true&&p.tool_name==='read_file'&&p.rejected_requests===0&&!p.failure,'Protocol roundtrip failed/incomplete');
  require(p.real_provider_verified===false&&p.llm_quality_verified===false&&p.offline_verified===false,'Protocol qualification overclaimed');
  require(p.requests?.length===2&&p.requests[0].returned_tool==='read_file'&&p.requests[1].marker_verified===true,'Model/tool sequence incomplete');
  require(/^[a-f0-9]{64}$/.test(p.marker_sha256)&&/^[a-f0-9]{64}$/.test(p.requests[1].tool_result_sha256),'Tool-result evidence absent');
  const rendered=r.snapshots?.find(x=>x.stage==='mock-chat-tool-roundtrip.png');
  require(rendered?.user_prompt_rendered===true&&rendered.assistant_reply_rendered===true&&rendered.stop_visible===false,'Rendered real turn not settled');
  require(r.screenshots?.length===2&&r.screenshots.some(x=>x.path==='mock-provider-configured.png')&&r.screenshots.some(x=>x.path==='mock-chat-tool-roundtrip.png'),'Required visual evidence absent');
  return true;
}

export function verifyDirectory(out) {
  const read=name=>JSON.parse(fs.readFileSync(path.join(out,name),'utf8').replace(/^\uFEFF/,''));
  const r=read('mock-chat.json');verifyReceipt(r);
  const lifecycle=read('installer-lifecycle.json');
  if(lifecycle.accepted_with_declared_limits!==true||lifecycle.error||lifecycle.installer_sha256!==r.installer_sha256
    ||lifecycle.forced_cleanup!==false)throw Error('Full exact-artifact lifecycle acceptance required');
  for(const name of ['installed','every_installed_payload_file_verified','native_window','contained_backend_health',
    'normal_window_close','contained_processes_stopped','normal_uninstall','installed_tree_removed',
    'synthetic_userdata_retained','debugger_owned_loopback','mocked_model_orchestration_verified']){
    if(lifecycle[name]!==true)throw Error(`Full exact-artifact lifecycle missing ${name}`);
  }
  const before=read('ui-debugger-owner.json'),after=read('ui-debugger-owner-after.json');
  for(const key of ['endpoint','listener_pid','process_created','install_root','executable','profile'])if(before[key]!==after[key])throw Error('Native debugger owner changed');
  for(const owner of [before,after])if(owner.native_job_member!==true||owner.exclusive_loopback_listener!==true||owner.profile_fresh!==true)throw Error('Native debugger ownership absent');
  for(const item of r.screenshots){
    if(path.basename(item.path)!==item.path)throw Error('Screenshot path escaped evidence');
    const bytes=fs.readFileSync(path.join(out,item.path));
    if(bytes.length!==item.bytes||createHash('sha256').update(bytes).digest('hex')!==item.sha256)throw Error('Screenshot integrity mismatch');
  }
  return {accepted:true,scope:'mocked-model-orchestration-only',installer_sha256:r.installer_sha256,real_provider_verified:false,offline_verified:false};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{console.log(JSON.stringify(verifyDirectory(process.argv[2]),null,2));}catch(e){console.error(e.message);process.exitCode=1;}
}
