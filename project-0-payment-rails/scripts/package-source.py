"""Build a source download from an explicit public-file inventory."""
from pathlib import Path
import zipfile
root = Path.cwd()
folders = ['simulator', 'web', 'data', 'tests', 'docs', 'screenshots', 'site', 'scripts']
files = ['README.md', 'AI_USAGE.md', 'TEST_REPORT.md', 'LICENSE', 'Dockerfile',
         'package.json', 'vercel.json', 'start.py', 'start_windows.bat', 'start_macos.command']
# Vercel excludes .dockerignore from CLI uploads. Keep a mandatory, tracked
# copy so the source download still has the same Docker build policy.
ignore_policy = (root/'scripts/source-dockerignore.txt').read_bytes()
if (root/'.dockerignore').exists() and (root/'.dockerignore').read_bytes() != ignore_policy:
    raise ValueError('.dockerignore differs from scripts/source-dockerignore.txt')
for name in files + folders:
    if not (root/name).exists():
        raise FileNotFoundError(root/name)
with zipfile.ZipFile(root/'site-dist/downloads/payment-rails-source.zip', 'w', zipfile.ZIP_DEFLATED) as archive:
    archive.writestr('project-0-payment-rails/.dockerignore', ignore_policy)
    inventory = [root/name for name in files]
    inventory += [p for name in folders for p in (root/name).rglob('*') if p.is_file()]
    for p in sorted(inventory):
        rel = p.relative_to(root)
        if p.is_symlink():
            raise ValueError(f'Symlink in source inventory: {rel}')
        if any(part in {'qa', '__pycache__', '.git', '.venv', 'node_modules', 'site-dist'} for part in rel.parts) or p.suffix in {'.pyc', '.aux', '.log', '.out'} or p.name == '.DS_Store':
            continue
        archive.write(p, 'project-0-payment-rails/' + rel.as_posix())
print('Created sanitized Payment Rails source ZIP.')
