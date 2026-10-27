"""Reproducible extension ZIP with separate provenance; never include user data."""
from pathlib import Path
import argparse
import hashlib
import json
import re
import subprocess
import zipfile

parser = argparse.ArgumentParser()
parser.add_argument('--channel', choices=['development', 'test', 'stable'], default='development')
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
extension = root / 'extension'
manifest = json.loads((extension / 'manifest.json').read_text())
version = manifest['version']
if not re.fullmatch(r'\d+(?:\.\d+){1,3}', version):
    raise SystemExit('Invalid extension version.')
def git(*values):
    return subprocess.check_output(['git', *values], cwd=root, text=True, stderr=subprocess.DEVNULL).strip()
try:
    commit = git('rev-parse', 'HEAD')
    dirty = bool(git('status', '--porcelain', '--untracked-files=normal'))
except (subprocess.CalledProcessError, FileNotFoundError):
    commit, dirty = None, True
if args.channel == 'stable':
    if manifest.get('version_name', version) != version:
        raise SystemExit('Stable packaging refuses a development-labelled manifest.')
    if not commit or dirty:
        raise SystemExit('Stable packaging requires a clean Git checkout.')
    try:
        if git('rev-parse', f'refs/tags/v{version}^{{commit}}') != commit:
            raise ValueError('tag mismatch')
    except (subprocess.CalledProcessError, ValueError):
        raise SystemExit('Stable packaging requires the matching version tag at HEAD.')
destination = root / 'dist' / f'ai-memory-collector-{version}.zip'
allowed = {'.json', '.js', '.html', '.css'}
if extension.is_symlink() or any(path.is_symlink() for path in extension.rglob('*')):
    raise SystemExit('Symlinks are not allowed in the extension.')
files = sorted(path for path in extension.rglob('*') if path.is_file())
if any(path.suffix not in allowed for path in files):
    raise SystemExit('Unexpected file in extension directory; review before packaging.')
destination.parent.mkdir(exist_ok=True)
with zipfile.ZipFile(destination, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
    for path in files:
        entry = zipfile.ZipInfo(str(path.relative_to(extension)), date_time=(1980, 1, 1, 0, 0, 0))
        entry.create_system = 3
        entry.external_attr = 0o100644 << 16
        entry.compress_type = zipfile.ZIP_DEFLATED
        archive.writestr(entry, path.read_bytes(), compresslevel=9)
digest = hashlib.sha256(destination.read_bytes()).hexdigest()
destination.with_suffix('.sha256').write_text(f'{digest}  {destination.name}\n')
metadata = {'schemaVersion': 1, 'version': version, 'channel': args.channel, 'sourceCommit': commit,
            'sourceDirty': dirty, 'fileCount': len(files), 'bytes': destination.stat().st_size, 'sha256': digest,
            'archive': destination.name}
destination.with_suffix('.json').write_text(json.dumps(metadata, indent=2) + '\n')
print(destination)
print(json.dumps(metadata))
