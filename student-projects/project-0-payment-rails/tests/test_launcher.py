"""Start the documented command, inspect health, and stop all programs cleanly."""
import json
from pathlib import Path
import queue
import subprocess
import sys
import threading
import time
import unittest
from urllib.request import urlopen


class Launcher(unittest.TestCase):
    def test_python_start_command_and_sigterm_shutdown(self):
        root = Path(__file__).resolve().parents[1]
        process = subprocess.Popen([sys.executable, "start.py", "--port", "0", "--seed", "41", "--no-browser"],
                                   cwd=str(root), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        lines = []
        messages = queue.Queue()

        def consume():
            for line in process.stdout:
                lines.append(line)
                messages.put(line)

        reader = threading.Thread(target=consume, daemon=True)
        reader.start()
        try:
            deadline = time.monotonic() + 10
            url = None
            while time.monotonic() < deadline:
                try:
                    line = messages.get(timeout=max(0.01, deadline - time.monotonic()))
                except queue.Empty:
                    break
                if line.startswith("http://"):
                    url = line.strip()
                    break
            self.assertIsNotNone(url, "Launcher did not print its URL: " + "".join(lines))
            with urlopen(url + "/healthz", timeout=5) as response:
                health = json.load(response)
            self.assertTrue(health["ok"])
            self.assertEqual(health["participants"], 6)
            process.terminate()
            self.assertEqual(process.wait(timeout=10), 0)
            reader.join(timeout=2)
            self.assertIn("All six participants stopped.", "".join(lines))
        finally:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
            reader.join(timeout=2)
            process.stdout.close()


if __name__ == "__main__":
    unittest.main()
