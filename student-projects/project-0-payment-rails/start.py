#!/usr/bin/env python3
"""Start six payment programs and the classroom dashboard with no dependencies."""
import argparse
import logging
import signal
import sys
import threading
import webbrowser
from simulator.server import make_server
from simulator.supervisor import Supervisor


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8010)
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()
    if sys.version_info < (3, 9):
        parser.error("Python 3.9 or newer is required.")
    if not 0 <= args.seed <= 2147483647:
        parser.error("Seed must be 0–2147483647.")
    if not 0 <= args.port <= 65535:
        parser.error("Port must be 0–65535.")
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s", datefmt="%H:%M:%S")
    stopped = threading.Event()
    signal.signal(signal.SIGINT, lambda *_: stopped.set())
    signal.signal(signal.SIGTERM, lambda *_: stopped.set())
    supervisor = Supervisor(args.seed)
    try:
        server = make_server(supervisor, args.host, args.port)
    except OSError as error:
        supervisor.close()
        parser.exit(1, "Could not start dashboard: %s\nTry --port 8011 if the port is in use.\n" % error)
    serving = threading.Thread(target=server.serve_forever, name="dashboard-http", daemon=True)
    serving.start()
    visible_host = "127.0.0.1" if args.host in ("0.0.0.0", "::") else args.host
    url = "http://%s:%s" % (visible_host, server.server_port)
    print("\nPayment Rails Live — Project 0\n" + url + "\nPress Ctrl+C to stop all six programs.\n", flush=True)
    if not args.no_browser:
        webbrowser.open(url)
    try:
        while not stopped.wait(0.25):
            pass
    finally:
        server.shutdown()
        server.server_close()
        serving.join(timeout=2)
        supervisor.close()
        print("All six participants stopped.", flush=True)


if __name__ == "__main__":
    main()
