"""A small same-origin JSON API and bundled static dashboard."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import mimetypes
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit
from .supervisor import CommandError, ROOT


def make_server(supervisor, host, port):
    web_root = (ROOT / "web").resolve()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format, *args):
            pass

        def send_bytes(self, payload, content_type, status=200):
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            try:
                self.wfile.write(payload)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def json(self, value, status=200):
            self.send_bytes(json.dumps(value, separators=(",", ":")).encode(), "application/json; charset=utf-8", status)

        def do_GET(self):
            url = urlsplit(self.path)
            if url.path == "/healthz":
                state = supervisor.state()
                self.json({"ok": not bool(state["fault"]), "session_id": state["session_id"],
                           "participants": len(state["agents"]), "fault": state["fault"]}, 503 if state["fault"] else 200)
            elif url.path == "/api/state":
                try:
                    after = int(parse_qs(url.query).get("after", ["0"])[0])
                    if after < 0:
                        raise ValueError()
                except ValueError:
                    self.json({"error": "after must be a nonnegative integer."}, 400)
                    return
                self.json(supervisor.state(after))
            elif url.path == "/api/trace":
                self.json(supervisor.state(full_trace=True))
            else:
                target = (web_root / unquote(url.path).lstrip("/")).resolve()
                if url.path == "/":
                    target = web_root / "index.html"
                if web_root not in target.parents or not target.is_file():
                    self.json({"error": "File not found."}, 404)
                    return
                self.send_bytes(target.read_bytes(), mimetypes.guess_type(str(target))[0] or "application/octet-stream")

        def do_POST(self):
            if urlsplit(self.path).path != "/api/command":
                self.json({"error": "Unknown endpoint."}, 404)
                return
            if self.headers.get("Content-Type", "").split(";")[0].strip() != "application/json":
                self.json({"error": "Use application/json."}, 415)
                return
            origin = self.headers.get("Origin")
            if origin and urlsplit(origin).netloc != self.headers.get("Host"):
                self.json({"error": "Commands must come from the dashboard's origin."}, 403)
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 1 <= length <= 65536:
                    raise CommandError("Command body must be 1–65536 bytes.")
                value = json.loads(self.rfile.read(length))
                self.json(supervisor.command(value))
            except (ValueError, UnicodeDecodeError) as error:
                self.json({"error": str(error)}, getattr(error, "status", 400))

    return ThreadingHTTPServer((host, port), Handler)
