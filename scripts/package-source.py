#!/usr/bin/env python3
"""Build a source-only ZIP; never include databases, credentials, installed dependencies or live run state."""
import argparse
import hashlib
import json
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parents[1]
VERSION = json.loads((ROOT/'package.json').read_text())['version']
TOP_FILES = {'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'package.json', 'package-lock.json', '.gitignore', 'server.mjs'}
DIRECTORIES = {'lib', 'public', 'tests', 'docs', 'scripts', 'desktop'}
DENY = {'node_modules', 'data', 'dist', 'bundle', 'bundle-win32-x64', '.runtime', '.git', '__pycache__', 'artifacts'}

def allowed(path):
    rel = path.relative_to(ROOT)
    if any(part in DENY for part in rel.parts):
        return False
    if path.suffix in {'.sqlite', '.db', '.log', '.pyc'} or path.name.startswith('.env'):
        return False
    return (len(rel.parts) == 1 and path.name in TOP_FILES) or (rel.parts[0] in DIRECTORIES)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, default=ROOT.parent / 'highway-agent-release' / f'Luheng-Office-Agent-v{VERSION}-source.zip')
    args = parser.parse_args()
    files = sorted(p for p in ROOT.rglob('*') if p.is_file() and not p.is_symlink() and allowed(p))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    manifest = [{'path': str(p.relative_to(ROOT)).replace('\\', '/'), 'bytes': p.stat().st_size, 'sha256': hashlib.sha256(p.read_bytes()).hexdigest()} for p in files]
    with zipfile.ZipFile(args.output, 'w', zipfile.ZIP_DEFLATED) as z:
        for p in files:
            z.write(p, 'highway-agent/' + str(p.relative_to(ROOT)).replace('\\', '/'))
        z.writestr('highway-agent/SOURCE-MANIFEST.json', json.dumps({'name': '路衡办公智能体', 'version': VERSION, 'type': 'source-only-not-installer', 'files': manifest}, ensure_ascii=False, indent=2))
    digest = hashlib.sha256(args.output.read_bytes()).hexdigest()
    args.output.with_suffix(args.output.suffix+'.sha256').write_text(digest+'  '+args.output.name+'\n')
    print(json.dumps({'path': str(args.output), 'files': len(files), 'bytes': args.output.stat().st_size, 'sha256': digest, 'containsRuntime': False, 'containsUserData': False}, ensure_ascii=False))
if __name__ == '__main__':
    main()
