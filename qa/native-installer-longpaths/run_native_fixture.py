"""Prepare only pinned native packaging tools, then test the small NSIS fixture."""
from pathlib import Path
import json
import hashlib
import shutil
import os
import subprocess
import sys
source,work,cache,fixture,consumer,pwsh=[Path(v).resolve() for v in sys.argv[1:7]]
sys.path.insert(0,str(source))
from scripts.bundles.desktop_toolchain import bootstrap_environment,prepare_tools
if '--worker' not in sys.argv:
 env=bootstrap_environment(source,work,cache,os.environ)
 for key in list(env):
  if any(p in key.upper() for p in ('TOKEN','SECRET','PASSWORD','API_KEY','CSC_LINK','AZURE_SIGN','APPLE_ID')):env.pop(key)
 Path(env['HOME']).mkdir(parents=True,exist_ok=True)
 launch="import sys,subprocess;from pathlib import Path;source,cache,entry,worker,work,fixture,consumer,pwsh=map(Path,sys.argv[1:]);sys.path.insert(0,str(source));from pm.runtime import runtime_command;cmd=runtime_command(entry,[str(worker),str(source),str(work),str(cache),str(fixture),str(consumer),str(pwsh),'--worker'],cache=cache/'python/runtime');sys.exit(subprocess.run(cmd,stdin=subprocess.DEVNULL).returncode)"
 sys.exit(subprocess.run([sys.executable,'-I','-S','-B','-c',launch,str(source),str(cache),str(source/'scripts/bundles/desktop_toolchain.py'),str(Path(__file__).resolve()),str(work),str(fixture),str(consumer),str(pwsh)],cwd=source,env=env).returncode)
assert os.name=='nt' and os.environ.get('GITHUB_ACTIONS')=='true'
python,node,env=prepare_tools(source,work,cache,os.environ)
env['CSC_IDENTITY_AUTO_DISCOVERY']='false';env['HERMES_DESKTOP_VARIANT']='bundled'
def run(args,cwd=source):subprocess.run([str(v) for v in args],cwd=cwd,env=env,stdin=subprocess.DEVNULL,check=True)
run([node,source/'scripts/build/node-deps.mjs','--source',source,'--workspace','apps/desktop'])
packager=work/'packager'
run([node,source/'apps/desktop/scripts/prepare-packaging-tools.mjs','--source',source,'--out',packager,'--cache',cache/'packager','--target','win32-x64','--format','nsis'])
# Exercise the real packaging regression suite before building even the tiny fixture.
run([node,source/'node_modules/vitest/vitest.mjs','run','--project','electron',
 'scripts/prepared-prepackaged.test.mjs','scripts/prepared-packaging.test.mjs',
 'scripts/prepared-native-deps.test.mjs','scripts/run-electron-builder.test.mjs'],cwd=source/'apps/desktop')
run([pwsh,'-NoLogo','-NoProfile','-NonInteractive','-File',fixture/'Test-NativeFixture.ps1','-Node',node,'-Source',source,'-Prepared',packager/'prepared.json','-Work',work/'fixture-run','-LifecycleConsumer',consumer])
result=json.loads((work/'fixture-run/fixture-result.json').read_text(encoding='utf-8-sig'))
assert not result['error'] and not result['forced_cleanup']
for key in ('installed','all_files_match','normal_uninstall','installed_tree_removed','registration_removed','sentinel_retained','long_path_policy_unchanged','junction_refused_without_deletion'):assert result[key] is True,key
build=json.loads((work/'fixture-run/fixture-build.json').read_text(encoding='utf-8-sig'))
prepared=json.loads((packager/'prepared.json').read_text(encoding='utf-8-sig'))
notices=work/'fixture-run/notices';notices.mkdir()
for name in ('LICENSE.txt','COPYING'):
 data=(Path(prepared['toolsets']['sevenZip'])/name).read_bytes();pin=build['supplier']['files'][name]
 assert len(data)==pin['bytes'] and hashlib.sha256(data).hexdigest()==pin['sha256']
 (notices/('7zip-'+name)).write_bytes(data)
shutil.copyfile(fixture/'electron-builder-LICENSE.txt',notices/'electron-builder-LICENSE.txt')
print('Small native NSIS long-path fixture passed; no application payload rebuilt or wrapped')
