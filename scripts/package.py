"""Package only the extension; never include archives, tokens or developer files."""
from pathlib import Path
import json
import zipfile

root = Path(__file__).resolve().parents[1]
extension = root / 'extension'
version = json.loads((extension / 'manifest.json').read_text())['version']
destination = root / 'dist' / f'ai-memory-collector-{version}.zip'
destination.parent.mkdir(exist_ok=True)
allowed = {'.json', '.js', '.html', '.css'}
files = sorted(path for path in extension.rglob('*') if path.is_file())
if any(path.suffix not in allowed or path.is_symlink() for path in files):
    raise SystemExit('Unexpected file in extension directory; review before packaging.')
with zipfile.ZipFile(destination, 'w', zipfile.ZIP_DEFLATED) as archive:
    for path in files:
        archive.write(path, path.relative_to(extension))
print(destination)
