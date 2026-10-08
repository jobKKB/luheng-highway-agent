"""Run actual Windows packaging tests before complete payload preparation."""
from pathlib import Path
import os
import subprocess
import sys

source, work, cache = [Path(v).resolve() for v in sys.argv[1:4]]
sys.path.insert(0, str(source))
from scripts.bundles.desktop_toolchain import bootstrap_environment, prepare_tools

if '--worker' not in sys.argv:
    env = bootstrap_environment(source, work, cache, os.environ)
    for key in list(env):
        if any(part in key.upper() for part in ('TOKEN', 'SECRET', 'PASSWORD', 'API_KEY', 'CSC_LINK', 'AZURE_SIGN', 'APPLE_ID')):
            env.pop(key)
    Path(env['HOME']).mkdir(parents=True, exist_ok=True)
    launch = "import sys,subprocess;from pathlib import Path;source,cache,entry,worker,work=map(Path,sys.argv[1:]);sys.path.insert(0,str(source));from pm.runtime import runtime_command;cmd=runtime_command(entry,[str(worker),str(source),str(work),str(cache),'--worker'],cache=cache/'python/runtime');sys.exit(subprocess.run(cmd,stdin=subprocess.DEVNULL).returncode)"
    result = subprocess.run([sys.executable, '-I', '-S', '-B', '-c', launch,
                             str(source), str(cache), str(source/'scripts/bundles/desktop_toolchain.py'),
                             str(Path(__file__).resolve()), str(work)], cwd=source, env=env)
    sys.exit(result.returncode)
assert os.name == 'nt'
python, node, env = prepare_tools(source, work, cache, os.environ)
subprocess.run([str(node), 'scripts/build/node-deps.mjs', '--source', str(source),
                '--workspace', 'apps/desktop'], cwd=source, env=env, check=True)
subprocess.run([str(node), str(source/'node_modules/vitest/vitest.mjs'), 'run', '--project', 'electron',
                'scripts/prepared-prepackaged.test.mjs', 'scripts/prepared-packaging.test.mjs',
                'scripts/prepared-native-deps.test.mjs', 'scripts/run-electron-builder.test.mjs'],
               cwd=source/'apps/desktop', env=env, check=True)
subprocess.run([str(node), str(source/'node_modules/typescript/bin/tsc'), '--ignoreConfig', '--allowJs', '--checkJs', '--noEmit', '--skipLibCheck', '--module', 'nodenext', '--moduleResolution', 'nodenext', '--target', 'es2022', 'electron-builder.nsis-prepackaged-test.cjs'], cwd=source/'apps/desktop', env=env, check=True)
print('Early real native Windows Vitest and NSIS config typecheck passed; no application payload built')
