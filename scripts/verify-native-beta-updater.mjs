import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir, readdir, lstat } from 'node:fs/promises';
import { join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const argv=process.argv.slice(2),opts={};
for(let i=0;i<argv.length;i++){const key=argv[i];assert.ok(['--source-root','--lock','--phase','--output-dir'].includes(key),key);assert.ok(argv[i+1]);opts[key.slice(2)]=argv[++i];}
const sourceRoot=resolve(opts['source-root']||fileURLToPath(new URL('..',import.meta.url)));
const out=resolve(opts['output-dir']||join(sourceRoot,'..','native-beta-proof'));
const phase=opts.phase||'check-source';assert.ok(['check-source','cancel','handoff','verify'].includes(phase));
await mkdir(out,{recursive:true});
const report={phase,status:'failed',actualWindows:false,installerExecuted:false,upgradePassed:false,checks:[],limits:['Unsigned packages; OS security prompts must be handled by the operator','Handoff is not installation success','Initial trusted Beta1 installation and visible NSIS completion are separate stages','Synthetic owned profile only; real providers and physical consumer Windows remain separate']};
let app,page;
const sha=b=>createHash('sha256').update(b).digest('hex');
const check=(name,condition=true)=>{assert.ok(condition,name);report.checks.push(name);};
async function seedProfile(l){
 const existing=await page.evaluate(()=>api('/api/state'));
 assert.equal(existing.tasks.length,0,'Owned fresh Beta1 profile must not contain tasks');
 assert.equal(existing.memories.length,0,'Owned fresh Beta1 profile must not contain knowledge');
 assert.equal(existing.skills.length,0,'Owned fresh Beta1 profile must not contain Skills');
 const records=await page.evaluate(async marker=>{
  const skill=await post('/api/skills/import',{files:[{path:'SKILL.md',content:'---\nname: Beta upgrade fixture\ndescription: Synthetic owned profile persistence check\n---\nDo not send messages or run tools; fixture '+marker+'\n'}]});
  const memory=await post('/api/memories',{title:'Synthetic upgrade knowledge',content:'Owned fixture '+marker,source:'CI owned beta fixture'});
  const reminder=await post('/api/reminders',{title:'Synthetic future reminder '+marker,dueAt:'2099-01-01T00:00:00.000Z'});
  const schedule=await post('/api/schedules',{title:'Synthetic paused schedule '+marker,prompt:'Owned fixture only',agentId:'coordinator',budget:2,timezone:'Asia/Shanghai',recurrence:{type:'interval',intervalMinutes:60},startAt:'2099-01-01T00:00:00.000Z',status:'paused'});
  const task=await post('/api/tasks',{prompt:'Synthetic upgrade fixture without a configured API key '+marker,agentId:'coordinator',budget:2,skillIds:[skill.id],submissionId:crypto.randomUUID()});
  return {skillId:skill.id,memoryId:memory.id,reminderId:reminder.id,scheduleId:schedule.id,taskId:task.id};
 },l.runMarker);
 await until(async()=>{const s=await page.evaluate(()=>api('/api/state'));const t=s.tasks.find(x=>x.id===records.taskId);return t?.status==='needs_attention';},'Unconfigured model task ends truthfully without network or success');
 const s=await page.evaluate(()=>api('/api/state'));const task=s.tasks.find(x=>x.id===records.taskId);assert.equal(task.modelUsageCalls.length,0);assert.equal(s.schedules.find(x=>x.id===records.scheduleId).runCount,0);
 const bundle=await readFile(join(l.stateRoot,'skills',records.skillId,'bundle.json'));report.fixture={...records,skillBundleSha256:sha(bundle)};await writeFile(join(out,'fixture-records.json'),JSON.stringify(report.fixture,null,2));
 check('Real installed backend created owned Skill, knowledge, future reminder, paused schedule and no-key task');
 assert.equal(s.desktop.credentialVault.available,true,'Actual Windows OS encryption must be available');assert.equal(s.desktop.credentialVault.backend,'dpapi');assert.equal(s.desktop.credentialVault.stored,false);
 const fake='CI_SYNTHETIC_NOT_A_PROVIDER_KEY_'+l.runMarker;
 await page.locator('#endpoint').fill('https://8.8.8.8/v1');await page.locator('#model').fill('owned-synthetic-no-network');await page.locator('#api-key').fill(fake);await page.locator('#budget').fill('2');await page.locator('#settings-form [type="submit"]').click();
 await until(async()=>(await page.evaluate(()=>api('/api/state'))).settings.hasApiKey,'Only owned synthetic key configured, without a model request');
 assert.equal(await page.locator('#desktop-credential-consent').isChecked(),false);assert.equal(await page.locator('#desktop-save-credentials').isDisabled(),true);await page.locator('#desktop-credential-consent').check();await page.locator('#desktop-save-credentials').click();
 await until(async()=>(await page.evaluate(()=>api('/api/state'))).desktop.credentialVault.stored,'Actual explicit native DPAPI save');const vault=await readFile(join(l.stateRoot,'credentials.vault'));assert.ok(!vault.includes(Buffer.from(fake)));report.fixture.vaultSha256=sha(vault);await writeFile(join(out,'fixture-records.json'),JSON.stringify(report.fixture,null,2));check('Actual packaged Windows DPAPI saves only after explicit UI opt-in; ciphertext excludes synthetic key');
}
async function until(fn,label,ms=30000){const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,100));}throw new Error('Timeout: '+label);}
function validateLock(l){
 assert.equal(l.schema,1);assert.equal(l.repository.id,1400818714);assert.equal(l.repository.fullName,'jobKKB/luheng-highway-agent');assert.equal(l.repository.ownerId,137971851);assert.equal(l.repository.ownerLogin,'jobKKB');
 assert.equal(l.from.version,'0.6.0-beta.1');assert.equal(l.to.version,'0.6.0-beta.2');
 for(const v of [l.from,l.to]){assert.match(v.commit,/^[a-f0-9]{40}$/);assert.match(v.tree,/^[a-f0-9]{40}$/);assert.ok(Number.isSafeInteger(v.releaseId)&&v.releaseId>0);assert.equal(v.tag,'v'+v.version);assert.equal(v.prerelease,true);assert.equal(v.draft,false);assert.ok(Number.isSafeInteger(v.assetId)&&v.assetId>0);assert.equal(v.assetName,`Luheng-Office-Agent-${v.version}-windows-x64.exe`);assert.match(v.sha256,/^[a-f0-9]{64}$/);assert.ok(Number.isSafeInteger(v.bytes)&&v.bytes>0);assert.match(v.installedExeSha256,/^[a-f0-9]{64}$/);assert.match(v.installedAsarSha256,/^[a-f0-9]{64}$/);assert.equal(v.nativeProofPassed,true);for(const key of ['payload','native']){assert.ok(isAbsolute(v.proof[key+'File']));assert.match(v.proof[key+'Sha256'],/^[a-f0-9]{64}$/);}}
 assert.ok(typeof l.installedExecutable==='string'&&isAbsolute(l.installedExecutable));assert.ok(typeof l.stateRoot==='string'&&isAbsolute(l.stateRoot));assert.match(l.runMarker,/^[a-f0-9]{32}$/);return l;
}
async function remote(l,policy){
 async function get(path){const r=await fetch('https://api.github.com/repos/jobKKB/luheng-highway-agent'+path,{headers:{accept:'application/vnd.github+json','user-agent':'Luheng-owned-beta-acceptance'},signal:AbortSignal.timeout(20000)});assert.equal(r.status,200,path);const s=await r.text();assert.ok(Buffer.byteLength(s)<2*1024*1024);return JSON.parse(s);}
 const repo=await get('');policy.validateRepository(repo);assert.equal(repo.owner.id,137971851);assert.equal(repo.owner.login,'jobKKB');
 const releases=[];
 for(const v of [l.from,l.to]){let ref=await get('/git/ref/tags/'+v.tag);for(let i=0;ref.object?.type==='tag'&&i<2;i++)ref=await get('/git/tags/'+ref.object.sha);assert.equal(ref.object?.type,'commit');assert.equal(ref.object.sha,v.commit,'Release tag exact immutable build commit');const r=await get('/releases/tags/'+v.tag);assert.equal(r.id,v.releaseId);assert.equal(r.draft,false);assert.equal(r.prerelease,true);const candidate=policy.validateRelease(r);assert.equal(candidate.version,v.version);assert.equal(candidate.assetId,v.assetId);assert.equal(candidate.sizeBytes,v.bytes);assert.equal(candidate.sha256,v.sha256);releases.push(r);}
 const c=policy.chooseCandidate(releases,{currentVersion:l.from.version,channel:'preview'});assert.equal(c.version,l.to.version);check('Exact fixed-repository public prereleases and digest metadata verified live');
}
async function installed(v,l){
 const payloadBytes=await readFile(v.proof.payloadFile),nativeBytes=await readFile(v.proof.nativeFile);assert.equal(sha(payloadBytes),v.proof.payloadSha256);assert.equal(sha(nativeBytes),v.proof.nativeSha256);
 const native=JSON.parse(nativeBytes),payload=JSON.parse(payloadBytes);assert.equal(native.status,'native-windows-smoke-passed');assert.ok(!native.cleanupError);assert.equal(native.version,v.version);assert.equal(native.commit,v.commit);assert.equal(native.installer.sha256,v.sha256);assert.equal(native.installer.bytes,v.bytes);assert.equal(payload.status,'installed-payload-bound');
 const {inventory}=await import(pathToFileURL(join(sourceRoot,'scripts','verify-windows-native.mjs')).href);const actual=await inventory(resolve(l.installedExecutable,'..'));
 for(const [name,expected] of Object.entries(payload.files))assert.deepEqual(actual[name],expected,'Installed payload '+name);
 assert.ok(Object.keys(actual).filter(name=>!Object.hasOwn(payload.files,name)).every(name=>['Uninstall Luheng Office Agent.exe','uninstallerIcon.ico'].includes(name)));
 check('All installed payload bytes match the exact native CI proof, without stale or extra app files');check('Installed EXE exact native-proof hash',sha(await readFile(l.installedExecutable))===v.installedExeSha256);check('Installed app.asar exact native-proof hash',sha(await readFile(join(resolve(l.installedExecutable,'..'),'resources','app.asar')))===v.installedAsarSha256);
}
async function cache(l){const root=join(l.stateRoot,'updates');const files=[];for(const d of await readdir(root,{withFileTypes:true})){if(!d.isDirectory()||!/^[a-f0-9]{32}$/.test(d.name))continue;for(const f of await readdir(join(root,d.name),{withFileTypes:true}))if(f.isFile()&&f.name.endsWith('.exe'))files.push(join(root,d.name,f.name));}
 assert.equal(files.length,1,'Exactly one owned ready update package');const file=files[0],stat=await lstat(file);assert.ok(stat.isFile()&&!stat.isSymbolicLink());assert.equal(stat.size,l.to.bytes);assert.equal(sha(await readFile(file)),l.to.sha256);const mark=await readFile(file+':Zone.Identifier','utf8');assert.match(mark,/(?:^|\n)ZoneId=3\r?(?:\n|$)/);assert.ok(mark.includes(`https://github.com/jobKKB/luheng-highway-agent/releases/download/${l.to.tag}/${l.to.assetName}`));check('Actual downloaded size/SHA256 and unchanged Internet MOTW verified');return file;}
async function nativeConsent(l,decision){const powershell=join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');const helper=join(fileURLToPath(new URL('.',import.meta.url)),'native-update-consent.ps1');const pid=app.process().pid;const p=exec(powershell,['-NoLogo','-NoProfile','-File',helper,'-OwnerPid',String(pid),'-ExpectedExecutable',l.installedExecutable,'-ExpectedHash',l.from.installedExeSha256,'-Version',l.to.version,'-Decision',decision],{timeout:35000,maxBuffer:65536,windowsHide:true});await page.locator('#update-install').click();const r=await p;assert.ok(r.stdout.includes('LUHENG_NATIVE_CONSENT_'+decision.toUpperCase()));check('Actual own-app native '+decision+' dialog, without dialog interception');}
try{
 const names=['desktop/main.cjs','desktop/update-policy.cjs','desktop/update-manager.cjs','desktop/update-files.cjs','desktop/update-transport.cjs','desktop/bridge.cjs','server.mjs','public/app.js'];report.sources=[];
 for(const name of names){const b=await readFile(join(sourceRoot,name));report.sources.push({path:name,bytes:b.length,sha256:sha(b)});}
 const require=createRequire(join(sourceRoot,'package.json'));const policy=require(join(sourceRoot,'desktop','update-policy.cjs'));
 assert.equal(policy.compareVersions('0.6.0-beta.2','0.6.0-beta.1'),1);assert.equal(policy.compareVersions('0.6.0-candidate.2','0.6.0-beta.2'),1);check('Actual strict SemVer policy requires beta1 to beta2, never candidate downgrade');
 if(phase==='check-source'){report.status='prepared-not-executed';}
 else{
  assert.equal(process.platform,'win32');assert.equal(process.arch,'x64');assert.equal(process.env.GITHUB_ACTIONS,'true');assert.equal(process.env.RUNNER_OS,'Windows');assert.ok(opts.lock);const lockBytes=await readFile(resolve(opts.lock));const l=validateLock(JSON.parse(lockBytes));report.lockSha256=sha(lockBytes);report.actualWindows=true;
  assert.equal(resolve(l.stateRoot),resolve(join(process.env.APPDATA,'LuhengOfficeAgent')),'Use the actual default profile so Shell/NSIS relaunch does not change data root');assert.equal(await readFile(join(l.stateRoot,'.owned-beta-qa'),'utf8'),l.runMarker);assert.ok(!process.env.HIGHWAY_DESKTOP_DATA_DIR,'No temporary profile environment override in Shell acceptance');assert.ok(!process.env.ELECTRON_DISABLE_SANDBOX,'Sandbox must remain enabled');
  await remote(l,policy);await installed(phase==='verify'?l.to:l.from,l);
  const {_electron}=require('playwright');app=await _electron.launch({executablePath:l.installedExecutable,args:[],timeout:60000});page=await app.firstWindow();
  const meta=await app.evaluate(({app})=>({version:app.getVersion(),packaged:app.isPackaged,sandboxDisabled:app.commandLine.hasSwitch('no-sandbox')}));assert.equal(meta.version,phase==='verify'?l.to.version:l.from.version);assert.equal(meta.packaged,true);assert.equal(meta.sandboxDisabled,false);report.native=meta;
  await page.locator('#prompt-input').waitFor();if(await page.locator('[data-action="local-defer"]').isVisible()){await page.locator('[data-action="local-defer"]').click();await page.locator('.modal').waitFor({state:'hidden'});}
  await page.locator('#nav [data-nav="settings"]').click();await until(()=>page.evaluate(()=>!!desktopUpdateStatus&&!desktopUpdatePolling),'actual update status');
  const status=()=>page.evaluate(()=>desktopUpdateStatus);const data=()=>page.evaluate(()=>api('/api/state'));
  check('Backend and native versions match', (await data()).system.version===meta.version);
  if(phase==='verify'){
   const handoff=JSON.parse(await readFile(join(out,'handoff-proof.json'),'utf8'));assert.equal(handoff.phase,'shell-handoff-only');assert.equal(handoff.toVersion,l.to.version);assert.equal(handoff.installerSha256,l.to.sha256);assert.equal(handoff.beta1Exited,true);
   const wizard=JSON.parse(await readFile(join(out,'wizard','owned-installer-wizard.json'),'utf8'));assert.equal(wizard.status,'owned-installer-wizard-passed');assert.equal(wizard.actualWindows,true);assert.equal(wizard.wizardCompleted,true);assert.equal(wizard.runAfterFinishDisabled,true);assert.equal(wizard.installerSha256,l.to.sha256);assert.equal(wizard.version,l.to.version);assert.equal(wizard.securityPromptBypassed,false);report.installerExecuted=true;
   const expected=JSON.parse(await readFile(join(out,'profile-before.json'),'utf8')),after=await data();for(const key of ['skills','memories','reminders','schedules'])assert.deepEqual(after[key],expected[key],key+' preserved');for(const t of expected.tasks){const actual=after.tasks.find(x=>x.id===t.id);assert.ok(actual);assert.equal(actual.status,t.status);assert.deepEqual(actual.modelUsageCalls,t.modelUsageCalls);}
   const fixture=JSON.parse(await readFile(join(out,'fixture-records.json'),'utf8'));assert.equal(sha(await readFile(join(l.stateRoot,'skills',fixture.skillId,'bundle.json'))),fixture.skillBundleSha256);assert.equal(sha(await readFile(join(l.stateRoot,'credentials.vault'))),fixture.vaultSha256);assert.equal(after.settings.hasApiKey,true);assert.equal(after.desktop.credentialVault.backend,'dpapi');assert.equal(after.desktop.credentialVault.available,true);assert.equal(after.desktop.credentialVault.stored,true);assert.ok(!after.desktop.credentialVault.restoreError);check('Owned persisted profile rows, Skill bytes, actual DPAPI credential recovery and existing task statuses preserved without new model usage');assert.equal((await status()).currentVersion,l.to.version);assert.equal((await status()).phase,'updated','Actual new native/backend versions must consume the genuine handoff journal');report.upgradePassed=true;report.status='beta-upgrade-verified';await page.screenshot({path:join(out,'beta2-verified.png'),animations:'allow',caret:'initial'});
  }else{
   await seedProfile(l);
   assert.equal(await page.locator('#update-channel-select').inputValue(),'stable');assert.equal((await status()).channel,'stable');check('Stable default has not silently selected preview');
   const before=await status();await page.locator('#update-channel-select').selectOption('preview');assert.deepEqual(await status(),before);check('Explicit preview choice itself does not check or download');await page.locator('#update-check').click();await until(async()=>!['checking','idle'].includes((await status()).phase),'release check',60000);const available=await status();assert.equal(available.phase,'available',available.error?.code);assert.equal(available.channel,'preview');assert.equal(available.candidate.version,l.to.version);assert.equal(available.candidate.sha256,l.to.sha256);assert.equal(available.candidate.sizeBytes,l.to.bytes);await page.locator('#update-download').click();await until(async()=>['ready','error','cancelled'].includes((await status()).phase),'actual installer download',600000);assert.equal((await status()).phase,'ready',(await status()).error?.code);await cache(l);await writeFile(join(out,'profile-before.json'),JSON.stringify(await data(),null,2));await page.screenshot({path:join(out,'beta1-ready.png'),animations:'allow',caret:'initial'});
   await nativeConsent(l,'cancel');await until(async()=>(await status()).phase==='ready','cancel retains ready');await cache(l);check('Native cancel keeps current process, ready package and MOTW');
   if(phase==='handoff'){const installerPath=await cache(l);const beta1Pid=app.process().pid;const startedAfterUtc=new Date().toISOString();const identity=await exec(join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoLogo','-NoProfile','-Command',`([Diagnostics.Process]::GetProcessById(${beta1Pid})).StartTime.ToUniversalTime().ToString('o')`],{windowsHide:true});const closed=new Promise(r=>app.once('close',r));await nativeConsent(l,'confirm');await Promise.race([closed,new Promise((_,reject)=>setTimeout(()=>reject(new Error('App did not close after verified shutdown/Shell request')),35000))]);app=null;const journal=JSON.parse(await readFile(join(l.stateRoot,'updates','pending.json'),'utf8'));assert.deepEqual(journal,{schema:1,version:l.to.version,sha256:l.to.sha256});await writeFile(join(out,'handoff-proof.json'),JSON.stringify({schema:1,phase:'shell-handoff-only',fromVersion:l.from.version,toVersion:l.to.version,installerPath,installerSha256:l.to.sha256,startedAfterUtc,beta1Pid,beta1StartUtc:identity.stdout.trim(),beta1ExeSha256:l.from.installedExeSha256,beta1Exited:true},null,2));report.installerExecuted=false;report.status='shell-handoff-only';report.operatorAction='Complete the visible owned installer; never bypass OS security prompts. Then run verify phase against exact Beta2 hashes.';}
   else report.status='native-cancel-verified';
  }
 }
}catch(error){report.error=String(error.message);process.exitCode=1;if(page)await page.screenshot({path:join(out,'failure.png'),animations:'allow',caret:'initial'}).catch(()=>{});}
finally{report.cleanupErrors=[];try{await app?.close();}catch(e){report.cleanupErrors.push(String(e.message));process.exitCode=1;report.status='failed';}await writeFile(join(out,'native-beta-'+phase+'.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({phase,status:report.status,actualWindows:report.actualWindows,upgradePassed:report.upgradePassed,error:report.error,checks:report.checks.length}));}
