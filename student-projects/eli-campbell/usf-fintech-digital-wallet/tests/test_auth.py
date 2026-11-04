import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import auth


class AuthTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.dir.name, "credentials.json")

    def tearDown(self):
        self.dir.cleanup()

    def test_no_account_cannot_sign_in(self):
        self.assertFalse(auth.has_account(self.path))
        self.assertIsNone(auth.verify_login("eli", "whatever123", self.path))

    def test_create_then_sign_in(self):
        self.assertIsNone(auth.create_account("Eli", "correct horse", "A", self.path))
        self.assertTrue(auth.has_account(self.path))
        self.assertEqual(auth.verify_login("Eli", "correct horse", self.path), "A")
        self.assertEqual(auth.verify_login("  eli ", "correct horse", self.path), "A")

    def test_wrong_credentials_rejected(self):
        auth.create_account("Eli", "correct horse", "A", self.path)
        self.assertIsNone(auth.verify_login("Eli", "wrong password", self.path))
        self.assertIsNone(auth.verify_login("someone", "correct horse", self.path))
        self.assertIsNone(auth.verify_login("Eli", "", self.path))

    def test_password_not_stored_in_plain_text(self):
        auth.create_account("Eli", "correct horse", "A", self.path)
        with open(self.path) as f:
            raw = f.read()
        self.assertNotIn("correct horse", raw)
        self.assertEqual(set(json.loads(raw)), {"username", "wallet", "salt", "hash", "iterations"})

    def test_salt_makes_hashes_differ(self):
        _, h1 = auth.hash_password("same password")
        _, h2 = auth.hash_password("same password")
        self.assertNotEqual(h1, h2)

    def test_validation(self):
        self.assertIn("required", auth.create_account("  ", "correct horse", "A", self.path))
        self.assertIn("at least", auth.create_account("Eli", "short", "A", self.path))
        self.assertFalse(auth.has_account(self.path))

    def test_demo_account_is_created_once_and_signs_in(self):
        auth.ensure_demo_account(self.path)
        self.assertEqual(auth.verify_login(auth.DEMO_USERNAME, auth.DEMO_PASSWORD, self.path), "A")
        with open(self.path) as f:
            self.assertNotIn(auth.DEMO_PASSWORD, f.read())
        auth.ensure_demo_account(self.path)  # second call must not change anything
        self.assertEqual(auth.verify_login("localhost", "money123", self.path), "A")
        self.assertIsNone(auth.verify_login("localhost", "wrong", self.path))

    def test_cannot_overwrite_existing_account(self):
        auth.create_account("Eli", "correct horse", "A", self.path)
        self.assertIsNotNone(auth.create_account("Mallory", "another password", "A", self.path))
        self.assertEqual(auth.verify_login("Eli", "correct horse", self.path), "A")


if __name__ == "__main__":
    unittest.main()
