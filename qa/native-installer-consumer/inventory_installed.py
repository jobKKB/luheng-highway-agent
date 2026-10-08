"""Read-only installed membership/hash diagnostics; never admission or repair."""
from pathlib import Path
import argparse
import hashlib
import json
import os
import sys
sys.path.insert(0, str(Path(__file__).resolve().parent))
from verify_consumer import contract, owned, read_json, verify_file


def inventory(root, manifest):
    root = Path(root).absolute()
    # Validate the un-resolved root and ancestors before any traversal.
    owned(root, '_inventory-root-admission')
    if not root.is_dir(): raise ValueError('Installed root missing')
    expected = {r['path']: r for r in manifest['files']}
    if len(expected) != len(manifest['files']):
        raise ValueError('Duplicate source manifest membership')
    actual = {}; errors = []
    for directory, dirs, files in os.walk(root, followlinks=False):
        for name in list(dirs):
            relative = (Path(directory)/name).relative_to(root).as_posix()
            try: owned(root, relative)
            except Exception as exc:
                errors.append({'path':relative,'error':str(exc)});dirs.remove(name)
        for name in files:
            relative = (Path(directory)/name).relative_to(root).as_posix()
            try:
                p = owned(root, relative)
                if not p.is_file(): raise ValueError('Non-regular installed entry')
                with p.open('rb') as f: digest = hashlib.file_digest(f,'sha256').hexdigest()
                actual[relative] = {'path':relative,'bytes':p.stat().st_size,'sha256':digest}
            except Exception as exc: errors.append({'path':relative,'error':str(exc)})
    missing = [expected[n] for n in sorted(set(expected)-set(actual))]
    added = [actual[n] for n in sorted(set(actual)-set(expected))]
    changed = [{'path':n,'expected':expected[n],'actual':actual[n]} for n in sorted(set(expected)&set(actual))
               if expected[n]['bytes'] != actual[n]['bytes'] or expected[n]['sha256'] != actual[n]['sha256']]
    result = {'schema':1,'diagnostic_only':True,'acceptance_claim':False,'source_commit':manifest['source_commit'],
              'source_tree_sha256':manifest['source_tree_sha256'],'expected_files':len(expected),
              'actual_hashed_files':len(actual),'actual_bytes':sum(r['bytes'] for r in actual.values()),
              'missing':missing,'added':added,'changed':changed,'read_errors':errors}
    return sorted(actual.values(),key=lambda r:r['path']),result


def main():
    p=argparse.ArgumentParser(description=__doc__)
    for key in ('contract','evidence','root','output'):p.add_argument('--'+key,type=Path,required=True)
    a=p.parse_args();pins=contract(a.contract)
    manifest=read_json(verify_file(a.evidence,pins['evidenceFiles']['structure']))
    if manifest['source_commit'] != pins['source']['commit'] or manifest['source_tree_sha256'] != pins['source']['treeSha256']:
        raise ValueError('Diagnostic source identity differs')
    rows,result=inventory(a.root,manifest);a.output.mkdir(parents=True,exist_ok=True)
    (a.output/'installed-inventory.json').write_text(json.dumps({'schema':1,'diagnostic_only':True,'files':rows},indent=2)+'\n',encoding='utf-8')
    (a.output/'installed-diff.json').write_text(json.dumps(result,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({k:v for k,v in result.items() if k not in ('missing','added','changed','read_errors')},ensure_ascii=False))
    print(json.dumps({'missing_files':len(result['missing']),'added_files':len(result['added']),'changed_files':len(result['changed']),'read_errors':result['read_errors']},ensure_ascii=False))
    print('Diagnostic additions: '+json.dumps(result['added'],ensure_ascii=False))
    print('Diagnostic missing: '+json.dumps(result['missing'],ensure_ascii=False))
    return 1 if result['read_errors'] else 0

if __name__=='__main__':raise SystemExit(main())
