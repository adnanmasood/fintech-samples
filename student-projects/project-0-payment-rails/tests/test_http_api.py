"""Verify the documented JSON interface with actual HTTP requests."""
import json
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from simulator.server import make_server
from simulator.supervisor import Supervisor


class HttpAPI(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.supervisor = Supervisor(start_scheduler=False)
        try:
            cls.server = make_server(cls.supervisor, "127.0.0.1", 0)
        except Exception:
            cls.supervisor.close()
            raise
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = "http://127.0.0.1:" + str(cls.server.server_port)

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=2)
        processes = list(cls.supervisor.processes.values())
        cls.supervisor.close()
        if any(process.is_alive() for process in processes):
            raise AssertionError("A participant remained alive after shutdown.")

    def request(self, path, value=None, **headers):
        if value is None:
            request = Request(self.base + path, headers=headers)
        else:
            request = Request(self.base + path, data=json.dumps(value).encode(),
                              headers=dict({"Content-Type": "application/json"}, **headers))
        with urlopen(request, timeout=10) as response:
            return json.load(response)

    def test_health_state_commands_and_incremental_trace(self):
        self.assertTrue(self.request("/healthz")["ok"])
        self.assertEqual(self.request("/healthz")["participants"], 6)
        result = self.request("/api/command", {"action": "purchase"})
        self.assertTrue(result["payment_id"])
        self.request("/api/command", {"action": "step"})
        self.assertEqual(len(self.request("/api/state?after=0")["events"]), 1)
        self.assertEqual(self.request("/api/state?after=1")["events"], [])
        self.assertEqual(len(self.request("/api/trace")["events"]), 1)

    def test_bad_inputs_are_json_errors(self):
        for path, value, headers, status in (("/api/state?after=-1", None, {}, 400),
                ("/api/command", {"action": "settle"}, {}, 409),
                ("/api/command", {"action": "step"}, {"Origin": "https://other.example"}, 403),
                ("/api/command", {"action": "step"}, {"Content-Type": "text/plain"}, 415),
                ("/../../start.py", None, {}, 404)):
            with self.assertRaises(HTTPError) as caught:
                self.request(path, value, **headers)
            self.assertEqual(caught.exception.code, status)
            self.assertIn("error", json.load(caught.exception))

    def test_invalid_command_field_types_are_400(self):
        for field in ("action", "preset", "payment_id", "batch_id", "account_id", "network", "operation_id", "currency"):
            with self.assertRaises(HTTPError) as caught:
                self.request("/api/command", dict({"action": "purchase"}, **{field: []}))
            self.assertEqual(caught.exception.code, 400)
            self.assertIn("error", json.load(caught.exception))


if __name__ == "__main__":
    unittest.main()
