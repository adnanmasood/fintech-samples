"""Export only committed instructor applications, never a whole course repo.

Usage: python3 scripts/export-vercel-source.py --commit <sha> --output <new-dir>
The sibling .inventory.json records provenance and hashes outside the upload.
"""
from pathlib import Path, PurePosixPath
import argparse
import hashlib
import io
import json
import subprocess
import tarfile

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--commit', required=True)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
commit = subprocess.check_output(['git', 'rev-parse', '--verify', args.commit+'^{commit}'],
                                 cwd=ROOT, text=True).strip()
allow = ['fintech-algorithms', 'project-0-payment-rails', 'LICENSE', '.vercelignore']
excluded = {'.git', '.vercel', 'node_modules', '.pnpm-store', '.astro', '.venv',
            '__pycache__', 'dist', 'site-dist', 'artifacts', 'test-results',
            'playwright-report', 'qa', 'source', 'student-projects'}
data = subprocess.check_output(['git', 'archive', '--format=tar', commit, '--', *allow], cwd=ROOT)
inventory = []
with tarfile.open(fileobj=io.BytesIO(data)) as archive:
    members = archive.getmembers()
    for member in members:
        rel = PurePosixPath(member.name)
        if member.isdir():
            continue
        if rel.name == '.gitkeep' and any(part in excluded for part in rel.parts):
            continue
        if not member.isfile() or rel.is_absolute() or '..' in rel.parts:
            raise ValueError(f'Unsafe export member: {rel}')
        if rel.parts[0] not in allow:
            raise ValueError(f'Outside instructor allowlist: {rel}')
        if any(part in excluded for part in rel.parts) or rel.name.startswith('.env'):
            raise ValueError(f'Excluded deployment member: {rel}')
        inventory.append({'path': str(rel), 'sha256': hashlib.sha256(archive.extractfile(member).read()).hexdigest()})
    args.output.mkdir(parents=True, exist_ok=False)
    archive.extractall(args.output, members=[m for m in members if m.isfile() and
                       any(item['path'] == m.name for item in inventory)], filter='data')
args.output.with_name(args.output.name+'.inventory.json').write_text(
    json.dumps({'commit': commit, 'allowlist': allow, 'files': inventory}, indent=2)+'\n')
print(f'Exported {len(inventory)} instructor files from {commit} to {args.output}')
