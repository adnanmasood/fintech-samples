"""Verify the actual Vercel build input and downloadable source package."""
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
import zipfile


ROOT = Path(__file__).resolve().parents[1]


class SourcePackageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)/'project-0-payment-rails'
        shutil.copytree(ROOT, self.root, ignore=shutil.ignore_patterns(
            'site-dist', '__pycache__', '.venv', 'node_modules', 'qa'))

    def build(self, root):
        return subprocess.run(['node', 'scripts/build-site.mjs'], cwd=root,
                              capture_output=True, text=True)

    def test_vercel_missing_dotfile_and_extracted_guide_build(self):
        policy = (self.root/'.dockerignore').read_bytes()
        (self.root/'.dockerignore').unlink()
        result = self.build(self.root)
        self.assertEqual(result.returncode, 0, result.stderr)
        with zipfile.ZipFile(self.root/'site-dist/downloads/payment-rails-source.zip') as archive:
            self.assertEqual(archive.read('project-0-payment-rails/.dockerignore'), policy)
            for name in ['LICENSE', 'package.json', 'vercel.json', 'start.py',
                         'Dockerfile', 'site/index.html', 'scripts/build-site.mjs',
                         'scripts/package-source.py', 'scripts/source-dockerignore.txt']:
                self.assertIn('project-0-payment-rails/'+name, archive.namelist())
            extracted = Path(self.temp.name)/'extracted'
            archive.extractall(extracted)
        result = self.build(extracted/'project-0-payment-rails')
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_other_missing_required_input_fails(self):
        (self.root/'LICENSE').unlink()
        result = self.build(self.root)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('LICENSE', result.stderr)

    def test_docker_policy_drift_fails(self):
        (self.root/'.dockerignore').write_text('different-policy\n')
        result = self.build(self.root)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('differs from', result.stderr)
