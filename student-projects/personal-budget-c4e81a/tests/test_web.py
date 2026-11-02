"""End-to-end check of the web dashboard over real HTTP."""
import http.client
import tempfile
import threading
import unittest
from http.server import HTTPServer
from pathlib import Path
from urllib.parse import urlencode

from budget_assistant.service import load_budgets
from budget_assistant.store import JsonStore
from budget_assistant.web import Handler

DATA = Path(__file__).resolve().parent.parent / "data"


class TestWeb(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        Handler.store = JsonStore(Path(cls.tmp.name) / "s.json")
        Handler.budgets = load_budgets(DATA / "budgets.json")
        cls.srv = HTTPServer(("127.0.0.1", 0), Handler)
        cls.port = cls.srv.server_address[1]
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.srv.server_close()
        cls.tmp.cleanup()

    def req(self, method, path, user=None, body=None, ctype=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port)
        h = {}
        if user:
            h["Cookie"] = f"user={user}"
        if ctype:
            h["Content-Type"] = ctype
        c.request(method, path, body=body, headers=h)
        r = c.getresponse()
        return r.status, r.read().decode(), dict(r.getheaders())

    def upload(self, user, name, content: bytes):
        b = "----x7"
        body = (f"--{b}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{name}\"\r\n"
                f"Content-Type: text/csv\r\n\r\n").encode() + content + f"\r\n--{b}--\r\n".encode()
        return self.req("POST", "/upload", user, body, f"multipart/form-data; boundary={b}")

    def test_upload_report_and_isolation(self):
        st, _, h = self.upload("household-a", "s.csv", (DATA / "sample_transactions.csv").read_bytes())
        self.assertEqual(st, 303)
        self.assertIn("4%20rejected", h["Location"])
        _, page, _ = self.req("GET", "/", "household-a")
        self.assertIn("$1,695.49", page)
        self.assertIn("twenty", page)          # rejected row shown to the user
        _, page_b, _ = self.req("GET", "/", "household-b")
        self.assertNotIn("$1,695.49", page_b)  # B cannot see A's data
        st, _, h = self.req("POST", "/correct", "household-b",
                            urlencode({"txn_id": "S003", "category": "Dining"}),
                            "application/x-www-form-urlencoded")
        self.assertIn("not%20found", h["Location"])  # B cannot correct A's txn

    def test_post_without_sign_in_is_refused(self):
        st, _, _ = self.req("POST", "/reset")
        self.assertEqual(st, 401)


if __name__ == "__main__":
    unittest.main()
