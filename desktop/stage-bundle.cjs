'use strict';
// Build-machine task only. Startup never downloads a browser or imports user data.
const { cpSync, existsSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, statSync, chmodSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const path = require('node:path');
const { stripBuildOnlyShims, stagingPlan, assertWindowsX64Executable } = require('./stage-utils.cjs');
const target = process.argv[2] || process.platform;
const offlineDebian = process.argv.includes('--use-installed-chromium');
const plan = stagingPlan({ target, offlineDebian });
const root = path.resolve(__dirname, '..');
const bundle = path.join(__dirname, plan.bundleName);
const backend = path.join(bundle, 'backend');
const browserRuntime = path.join(bundle, 'browser-runtime');
const required = ['server.mjs','package.json','LICENSE','THIRD_PARTY_NOTICES.md','lib','public/index.html','public/app.js','node_modules/playwright/package.json','node_modules/playwright-core/package.json','node_modules/imapflow/package.json','node_modules/nodemailer/package.json','node_modules/mailparser/package.json'];
for (const entry of required) if (!existsSync(path.join(root, entry))) throw new Error(`Missing ${entry}; install root dependencies and finish UI before packaging.`);
const hashFile = file => createHash('sha256').update(readFileSync(file)).digest('hex');
mkdirSync(bundle, { recursive: true });
// A failed new staging run must not leave an old successful manifest usable.
rmSync(path.join(bundle, 'bundle-manifest.json'), { force: true });
rmSync(backend, { recursive: true, force: true });
mkdirSync(backend, { recursive: true });
for (const entry of ['server.mjs','package.json','LICENSE','THIRD_PARTY_NOTICES.md','lib','public','node_modules']) cpSync(path.join(root,entry),path.join(backend,entry),{recursive:true,dereference:true});
stripBuildOnlyShims(path.join(backend, 'node_modules'));
let executable, browserSource, browserVersion, browserRevision = null;
if (offlineDebian) {
  const installed = '/usr/lib/chromium';
  const expectedHash = 'd387400aaf740ccb75e5e996a34aa0940e6e97683a4eabd6ae34c1eed6804723';
  const installedExe = path.join(installed,'chromium');
  if (!existsSync(installedExe) || hashFile(installedExe) !== expectedHash) throw new Error('Installed Chromium differs from the explicitly reviewed 151.0.7922.173 binary; review and repin before packaging.');
  const version = spawnSync(installedExe,['--version'],{encoding:'utf8'});
  if (version.status !== 0 || !version.stdout.includes('151.0.7922.173')) throw new Error('Unexpected installed Chromium version.');
  rmSync(browserRuntime,{recursive:true,force:true});
  const destination = path.join(browserRuntime,'debian-chromium');
  cpSync(installed,destination,{recursive:true,dereference:true,filter:source=>path.basename(source)!=='chrome-sandbox'});
  // Portable artifacts do not create a setuid helper. Host user-namespace sandbox
  // support is required; sandbox flags are never disabled to make the build run.
  if (existsSync(path.join(installed,'chrome-sandbox'))) writeFileSync(path.join(destination,'chrome-sandbox'),readFileSync(path.join(installed,'chrome-sandbox')),{mode:0o755});
  cpSync('/usr/share/doc/chromium/copyright',path.join(browserRuntime,'COPYRIGHT.debian-chromium'));
  executable = path.join(destination,'chromium'); chmodSync(executable,0o755);
  browserSource = 'existing Debian 13 Chromium runtime; copied locally without a network workaround';
  browserVersion = '151.0.7922.173';
  writeFileSync(path.join(browserRuntime,'BROWSER-SOURCE.txt'),`Pinned offline Linux x64 runtime\nSource: /usr/lib/chromium, Debian 13 (trixie)\nVersion: ${browserVersion}\nExecutable SHA256: ${expectedHash}\nPlaywright API dependency remains 1.58.2. This is not its unavailable Chrome for Testing 145.0.7632.6 / chromium v1208 download.\nRequires compatible Linux shared libraries and a functioning Chromium user-namespace sandbox. No setuid setup or sandbox disabling is performed.\nSee COPYRIGHT.debian-chromium and runtime-sha256.json.\n`);
} else {
  const env = {...process.env,PLAYWRIGHT_BROWSERS_PATH:browserRuntime};
  // Playwright's pinned internal cross-target selector applies to both download
  // and executable lookup. Never substitute the build host's browser.
  if (plan.playwrightPlatform) env.PLAYWRIGHT_HOST_PLATFORM_OVERRIDE = plan.playwrightPlatform;
  else delete env.PLAYWRIGHT_HOST_PLATFORM_OVERRIDE;
  const install=spawnSync(process.execPath,[path.join(root,'node_modules/playwright/cli.js'),'install','--no-shell','chromium'],{stdio:'inherit',env});
  if(install.status!==0)throw new Error('Official build-time Chromium download failed; no installer was built. Do not silently substitute another source.');
  const probe=spawnSync(process.execPath,['-e','process.stdout.write(require("playwright").chromium.executablePath())'],{cwd:root,env,encoding:'utf8'});
  if(probe.status!==0)throw new Error('Cannot resolve bundled Playwright Chromium.');
  executable=probe.stdout.trim();
  const info=JSON.parse(readFileSync(path.join(root,'node_modules/playwright-core/browsers.json'),'utf8')).browsers.find(x=>x.name==='chromium');
  browserSource='official Playwright browser installer';browserVersion=info.browserVersion;browserRevision=info.revision;
  rmSync(path.join(browserRuntime,'.links'),{recursive:true,force:true});
}
const relativeExecutable=path.relative(browserRuntime,executable);
if(relativeExecutable.startsWith('..')||path.isAbsolute(relativeExecutable)||!existsSync(executable))throw new Error('The selected browser is not contained in the bundle.');
if (target === 'win32') assertWindowsX64Executable(executable);
const hashes={};
function walk(dir){for(const name of readdirSync(dir).sort()){const file=path.join(dir,name);if(statSync(file).isDirectory())walk(file);else if(name!=='runtime-sha256.json')hashes[path.relative(browserRuntime,file).split(path.sep).join('/')]=hashFile(file);}}
walk(browserRuntime);
writeFileSync(path.join(browserRuntime,'runtime-sha256.json'),JSON.stringify({source:browserSource,version:browserVersion,files:hashes},null,2)+'\n');
writeFileSync(path.join(bundle,'bundle-manifest.json'),JSON.stringify({target,arch:process.arch,createdAt:new Date().toISOString(),backend:'Electron bundled Node.js, local utility process',browserSource,browserVersion,browserRevision,browserExecutable:relativeExecutable.split(path.sep).join('/'),browserExecutableSha256:hashFile(executable),playwrightVersion:require(path.join(root,'node_modules/playwright/package.json')).version,containsUserData:false},null,2)+'\n');
console.log(`Staged source and pinned ${browserVersion} browser for ${target}/${process.arch}: ${bundle}`);
