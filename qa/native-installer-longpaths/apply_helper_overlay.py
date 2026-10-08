"""Apply only reviewed installer-helper source after original source admission."""
from pathlib import Path
import argparse
import base64
import hashlib
import importlib.util
import json
import os
import subprocess
import sys
sys.dont_write_bytecode=True
BASE_TREE='d37c08c19b1e57ce4829682c4f84ec5fc89bf1fd3c5fc56e0e2b7153f462b4cb'
ALLOWED={
 'apps/desktop/electron-builder.nsis-prepackaged-test.cjs',
 'apps/desktop/scripts/nsis-longpaths-inputs.mjs',
 'apps/desktop/scripts/run-electron-builder.mjs',
 'apps/desktop/scripts/prepared-packaging.mjs',
 'apps/desktop/build/nsis-longpaths.nsh',
 'apps/desktop/scripts/prepared-prepackaged.test.mjs',
}
def main():
 p=argparse.ArgumentParser(description=__doc__)
 for name in ('controller','source','overlay','output'):p.add_argument('--'+name,type=Path,required=True)
 a=p.parse_args();source=a.source.resolve();controller=a.controller.resolve()
 spec=importlib.util.spec_from_file_location('admitted_source',controller/'qa/hermes-native/materialize-v2-source.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
 identity,manifest,_=m.load_controller(controller)
 if identity['source_tree_sha256']!=BASE_TREE or identity['source_count']!=17260:raise ValueError('Unexpected original helper-source baseline')
 m.verify_source(source,manifest)
 if subprocess.check_output(['git','-C',str(source),'status','--porcelain'],text=True).strip():raise ValueError('Helper baseline checkout is dirty')
 overlay=json.loads(a.overlay.read_text(encoding='utf-8-sig'))
 if overlay['schema']!=1 or overlay['base_source_tree_sha256']!=BASE_TREE or overlay['base_source_count']!=17260:raise ValueError('Helper overlay baseline differs')
 rows={r['path']:dict(r) for r in manifest['source_files']};changes=overlay['files']
 if {r['path'] for r in changes}!=ALLOWED or len(changes)!=len(ALLOWED):raise ValueError('Unreviewed installer helper paths')
 for row in changes:
  name=row['path'];before=rows.get(name);expected=row['base_sha256']
  if (before['sha256'] if before else None)!=expected:raise ValueError('Helper before pin differs: '+name)
  path=m.owned_path(source,name)
  if not before and path.exists():raise ValueError('New helper input already exists')
  data=base64.b64decode(row['content_base64'],validate=True)
  if len(data)!=row['bytes'] or hashlib.sha256(data).hexdigest()!=row['sha256']:raise ValueError('Helper overlay bytes differ')
  path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(data)
  if os.name!='nt':path.chmod(int(row['mode'],8))
  rows[name]={k:row[k] for k in ('path','bytes','sha256','mode')}
 expected_tree=m.tree_digest(rows)
 if expected_tree!=overlay['helper_source_tree_sha256'] or len(rows)!=overlay['helper_source_count']:raise ValueError('Helper tree identity differs')
 updated=dict(manifest);updated['source_files']=[rows[n] for n in sorted(rows)]
 result=m.verify_source(source,updated)
 for name in sorted(ALLOWED):subprocess.run(['git','-C',str(source),'add','-f','--',name],check=True)
 subprocess.run(['git','-C',str(source),'-c','user.name=Luheng CI Installer Helper','-c','user.email=ci-installer@invalid.example','commit','-m','Apply reviewed installer-only long-path helpers'],check=True)
 if subprocess.check_output(['git','-C',str(source),'status','--porcelain'],text=True).strip():raise ValueError('Helper source dirty after commit')
 m.verify_source(source,updated)
 result.update({'schema':1,'base_source_tree_sha256':BASE_TREE,'helper_source_commit':subprocess.check_output(['git','-C',str(source),'rev-parse','HEAD'],text=True).strip(),'source_only':True,'payload_rebuilt':False,'changed_paths':sorted(ALLOWED)})
 a.output.parent.mkdir(parents=True,exist_ok=True);a.output.write_text(json.dumps(result,indent=2)+'\n',encoding='utf-8');print(json.dumps(result))
if __name__=='__main__':main()
