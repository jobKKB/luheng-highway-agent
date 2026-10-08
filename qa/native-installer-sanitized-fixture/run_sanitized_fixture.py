"""Reproduce full consumer helper preparation/environment with only the tiny fixture."""
from pathlib import Path
import json
import os
import subprocess
import sys

source, job, fixture, consumer, pwsh = [Path(v).resolve() for v in sys.argv[1:6]]
bootstrap_work, bootstrap_cache = job / 'bootstrap-work', job / 'bootstrap-cache'
sys.path.insert(0, str(source))
from scripts.bundles.desktop_toolchain import bootstrap_environment, prepare_tools

if '--worker' not in sys.argv:
    if job.exists():
        raise ValueError('Fresh exact-layout diagnostic job root required')
    env = bootstrap_environment(source, bootstrap_work, bootstrap_cache, os.environ)
    for key in list(env):
        if any(part in key.upper() for part in ('TOKEN', 'SECRET', 'PASSWORD', 'API_KEY', 'CSC_LINK', 'AZURE_SIGN', 'APPLE_ID')):
            env.pop(key)
    Path(env['HOME']).mkdir(parents=True)
    launch = "import sys,subprocess;from pathlib import Path;source,cache,entry,worker,job,fixture,consumer,pwsh=map(Path,sys.argv[1:]);sys.path.insert(0,str(source));from pm.runtime import runtime_command;cmd=runtime_command(entry,[str(worker),str(source),str(job),str(fixture),str(consumer),str(pwsh),'--worker'],cache=cache/'python/runtime');sys.exit(subprocess.run(cmd,stdin=subprocess.DEVNULL).returncode)"
    raise SystemExit(subprocess.run([sys.executable, '-I', '-S', '-B', '-c', launch,
        str(source), str(bootstrap_cache), str(source/'scripts/bundles/desktop_toolchain.py'), str(Path(__file__).resolve()),
        str(job), str(fixture), str(consumer), str(pwsh)], cwd=source, env=env).returncode)

if os.name != 'nt' or os.environ.get('GITHUB_ACTIONS') != 'true':
    raise ValueError('Disposable native Windows GitHub Actions runner required')
if job != Path(os.environ['RUNNER_TEMP']).resolve() / 'luheng-nsis-longpath':
    raise ValueError('Use the full consumer exact job-root layout')
bootstrap_python, bootstrap_node, _ = prepare_tools(source, bootstrap_work, bootstrap_cache, os.environ)
# Import the deployed full consumer's function rather than maintaining a second
# interpretation of its allowlist, HOME/TEMP layout or npm configuration isolation.
sys.path.insert(0, str(consumer))
from prepare_and_package import child_env, run, verify_fixture_result
from pm.build_operations import verified_tools
from pm.lock import Lockfile

work, cache, output = job/'fresh-helper-work', job/'fresh-helper-cache', job/'diagnostic-evidence'
if work.exists() or cache.exists():
    raise ValueError('Fresh full-layout helper directories required')
work.mkdir(); cache.mkdir(); output.mkdir()
env = child_env(work, cache)
os.environ.clear(); os.environ.update(env)
# Equivalent lock-pinned tool selection, without fetching any application archive.
selection = verified_tools(['python', 'node', 'npm'], source_store=bootstrap_cache/'tools',
                           target='win32-x64', lock=Lockfile(source/'pm/lock.json'))
env = selection.environment(env)
python, node = [selection.entries[name].binary for name in ('python', 'node')]
if python != bootstrap_python or node != bootstrap_node:
    raise ValueError('Prepared and verified tool selection differs')
env.update({'HERMES_PYTHON':str(python), 'HERMES_NODE':str(node), 'PYTHON':str(python)})
keys = ['GITHUB_ACTIONS', 'RUNNER_TEMP', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
        'LOCALAPPDATA', 'APPDATA', 'TEMP', 'TMP', 'PATH', 'HERMES_HOME', 'HERMES_RUNTIME_DIR',
        'npm_config_cache', 'npm_config_userconfig', 'npm_config_globalconfig', 'CSC_IDENTITY_AUTO_DISCOVERY',
        'HERMES_DESKTOP_VARIANT', 'HERMES_PYTHON', 'HERMES_NODE', 'PYTHON']
(output/'fixture-environment.json').write_text(json.dumps({
    'schema':1, 'diagnostic_only':True, 'application_payload_downloaded':False,
    'work':str(work), 'cache':str(cache), 'fixture_work':str(work/'fixture'),
    'consumer_child_env_source':str(consumer/'prepare_and_package.py'),
    'environment':{key:env.get(key) for key in keys}}, indent=2)+'\n', encoding='utf-8')

native, packager = work/'native-deps', work/'packager'
scripts = source/'apps/desktop/scripts'
# Preserve the full consumer's exact preparation order and directory names.
run([node, source/'scripts/build/node-deps.mjs', '--source', source, '--workspace', 'apps/desktop'],
    source=source, env=env, evidence=output, label='fresh-node-preparation')
run([node, scripts/'stage-native-deps.mjs', '--source', source, '--out', native, '--platform', 'win32', '--arch', 'x64'],
    source=source, env=env, evidence=output, label='fresh-native-preparation')
run([node, scripts/'prepare-packaging-tools.mjs', '--source', source, '--out', packager,
     '--cache', cache/'packager', '--target', 'win32-x64', '--format', 'nsis'],
    source=source, env=env, evidence=output, label='fresh-packaging-preparation')
run([pwsh, '-NoLogo', '-NoProfile', '-NonInteractive', '-File', fixture/'Test-NativeFixture.ps1',
     '-Node', node, '-Source', source, '-Prepared', packager/'prepared.json',
     '-Work', work/'fixture', '-LifecycleConsumer', consumer],
    source=source, env=env, evidence=output, label='tiny-native-longpath-fixture')
verify_fixture_result(work/'fixture')
print('Exact full-consumer environment/layout tiny fixture passed; no application archive downloaded or wrapped')
