"""Transport, process lifecycle, and projections for the classroom dashboard."""
import copy
from collections import deque
from datetime import datetime, timezone
import json
import logging
import multiprocessing
from pathlib import Path
import queue
import random
import threading
import time
import uuid

from .common import LABELS, ROLES, PaymentError, batch_digest, identity, validate_payment
from .worker import worker_loop

ROOT = Path(__file__).resolve().parents[1]
LOG = logging.getLogger("payment-rails")


class CommandError(ValueError):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


class Supervisor:
    def __init__(self, seed=7, start_scheduler=True):
        self.lock = threading.RLock()
        self.stop_event = threading.Event()
        self.context = multiprocessing.get_context("spawn")
        self.accounts = json.loads((ROOT / "data/accounts.json").read_text())
        self.scenarios = json.loads((ROOT / "data/scenarios.json").read_text())
        self.processes = {}
        self.inboxes = {}
        self.results = None
        self.scheduler = None
        self._initialize(seed)
        if start_scheduler:
            self.scheduler = threading.Thread(target=self._automatic_loop, name="classroom-clock", daemon=True)
            self.scheduler.start()

    def _initialize(self, seed):
        self.seed = seed
        self.rng = random.Random(seed)
        self.session_id = uuid.uuid4().hex
        self.mode = "guided"
        self.paused = False
        self.speed_ms = 650
        self.fault = None
        self.pending = deque()
        self.events = []
        self.snapshots = {}
        self.agents = {}
        self.payments = {}
        self.batch_messages = {}
        self.payment_counter = self.batch_counter = self.delivery_counter = 0
        self.results = self.context.Queue()
        for role in ROLES:
            inbox = self.context.Queue()
            process = self.context.Process(target=worker_loop, name="payment-" + role,
                                           args=(role, inbox, self.results, self.session_id, self.accounts))
            process.start()
            self.inboxes[role] = inbox
            self.processes[role] = process
            self.agents[role] = {"id": role, "label": LABELS[role], "pid": process.pid,
                                 "alive": True, "received": 0, "sent": 0, "last_activity": "Ready for a message"}
        deadline = time.monotonic() + 15
        while len(self.snapshots) < len(ROLES):
            try:
                response = self.results.get(timeout=max(0.01, deadline - time.monotonic()))
            except queue.Empty:
                self._fail("A participant did not start. Reset the demonstration.")
                break
            if response.get("session_id") == self.session_id:
                self.snapshots[response["role"]] = response["snapshot"]
        LOG.info("Session %s: six participants ready; guided mode, seed %s", self.session_id[:8], seed)

    def _fail(self, reason):
        self.fault = reason
        self.paused = True
        LOG.error(reason)

    def _check_health(self):
        for role, process in self.processes.items():
            self.agents[role]["alive"] = process.is_alive()
            if not process.is_alive() and not self.fault and not self.stop_event.is_set():
                self._fail(LABELS[role] + " process stopped. Reset is required; pending outcomes are unknown.")

    def _stop_workers(self):
        for inbox in self.inboxes.values():
            inbox.put(None)
        for process in self.processes.values():
            process.join(timeout=2)
            if process.is_alive():
                process.terminate()
                process.join(timeout=2)
        for inbox in self.inboxes.values():
            inbox.close()
            inbox.join_thread()
        if self.results is not None:
            self.results.close()
            self.results.join_thread()
        self.inboxes = {}
        self.processes = {}

    def close(self):
        self.stop_event.set()
        if self.scheduler:
            self.scheduler.join(timeout=5)
        with self.lock:
            self._stop_workers()

    def _step(self):
        self._check_health()
        if self.fault:
            raise CommandError(self.fault, 409)
        if not self.pending:
            return None
        message = self.pending.popleft()
        role = message["recipient"]
        self.delivery_counter += 1
        delivery_id = self.delivery_counter
        self.inboxes[role].put((delivery_id, copy.deepcopy(message)))
        try:
            response = self.results.get(timeout=5)
        except queue.Empty:
            self._fail(LABELS[role] + " did not acknowledge delivery. Reset is required.")
            raise CommandError(self.fault, 409)
        if response.get("session_id") != self.session_id or response.get("delivery_id") != delivery_id:
            self._fail("Unexpected process response. Reset is required.")
            raise CommandError(self.fault, 409)
        if response.get("fatal"):
            LOG.error(response["fatal"])
            self._fail(LABELS[role] + " failed while receiving a message. Reset is required.")
            raise CommandError(self.fault, 409)
        result = response["result"]
        self.snapshots[role] = response["snapshot"]
        self.agents[role].update(received=response["received"], sent=response["sent"],
                                 last_activity=message["type"] + " · " + result["outcome"])
        # A continuation stays in front so each payment's response remains easy to follow.
        for outgoing in reversed(result["outgoing"]):
            self.pending.appendleft(outgoing)
        event = copy.deepcopy(message)
        event.update(seq=len(self.events) + 1, timestamp=datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
                     session_id=self.session_id, outcome=result["outcome"], reason=result["reason"],
                     explanation=result["explanation"], duplicate=result.get("duplicate", False))
        self.events.append(event)
        LOG.info("%03d %-10s → %-10s %-14s %s %s", event["seq"], message["sender"], role,
                 message["type"], message["payment_id"], result["outcome"])
        return event

    def _purchase(self, command):
        preset = command.get("preset", "approved")
        if preset not in self.scenarios:
            raise CommandError("Unknown preset.")
        inputs = dict(self.scenarios[preset])
        for key in ("amount_cents", "account_id", "network"):
            if key in command:
                inputs[key] = command[key]
        self.payment_counter += 1
        payment_id = command.get("payment_id", "P%04d" % self.payment_counter)
        message = dict(inputs, payment_id=payment_id, operation_id=command.get("operation_id", payment_id + ":authorize"),
                       merchant_id="campus-cafe", currency=command.get("currency", "USD"), type="PURCHASE",
                       sender="classroom", recipient="payer", outcome="", reason="")
        try:
            validate_payment(message)
        except PaymentError as error:
            raise CommandError(str(error))
        prior = self.payments.get(payment_id)
        if prior and (identity(prior) != identity(message) or prior["operation_id"] != message["operation_id"]):
            raise CommandError("Conflicting payment identifier or authorization operation.", 409)
        self.payments.setdefault(payment_id, copy.deepcopy(message))
        self.pending.append(message)
        return {"payment_id": payment_id, "operation_id": message["operation_id"]}

    def _merchant_payments(self):
        return self.snapshots.get("merchant", {}).get("payments", {})

    def _capture(self, payment_id):
        payment = self._merchant_payments().get(payment_id)
        if not payment:
            raise CommandError("Select a known payment.", 409)
        if payment["status"] not in ("AUTHORIZED", "CAPTURED", "CLEARED", "SETTLED"):
            raise CommandError("Capture requires an approved authorization.", 409)
        self.pending.append(dict(identity(payment), operation_id=payment_id + ":capture", type="CAPTURE",
                                 sender="classroom", recipient="merchant", outcome="", reason=""))
        return {"payment_id": payment_id}

    def _batch(self, action, batch_id=None):
        if action == "clear":
            if batch_id:
                if batch_id not in self.batch_messages:
                    raise CommandError("Unknown batch.", 409)
                message = copy.deepcopy(self.batch_messages[batch_id])
            else:
                items = [identity(item) for item in self._merchant_payments().values() if item["status"] == "CAPTURED"]
                if not items:
                    raise CommandError("Capture at least one approved payment before clearing.", 409)
                # Prevent two not-yet-delivered commands assigning the same sale to different batches.
                reserved = {item["payment_id"] for batch in self.batch_messages.values() for item in batch["items"]}
                items = [item for item in items if item["payment_id"] not in reserved]
                if not items:
                    raise CommandError("These captured payments already have a queued clearing batch.", 409)
                self.batch_counter += 1
                batch_id = "B%04d" % self.batch_counter
                message = dict(batch_id=batch_id, items=items, digest=batch_digest(items),
                               amount_cents=sum(item["amount_cents"] for item in items), currency="USD",
                               payment_id=items[0]["payment_id"] if len(items) == 1 else batch_id,
                               sender="classroom", recipient="merchant", outcome="", reason="", type="CLEAR_REQUEST",
                               operation_id=batch_id + ":clear")
                self.batch_messages[batch_id] = copy.deepcopy(message)
        else:
            batches = self.snapshots.get("merchant", {}).get("batches", {})
            if batch_id is None:
                batch_id = next((bid for bid, value in batches.items() if value["status"] == "CLEARED"), None)
            if not batch_id or batch_id not in batches or batches[batch_id]["status"] not in ("CLEARED", "SETTLED"):
                raise CommandError("Clear a batch before settlement.", 409)
            message = dict(copy.deepcopy(self.batch_messages[batch_id]), type="SETTLE_REQUEST", operation_id=batch_id + ":settle")
        self.pending.append(message)
        return {"batch_id": batch_id}

    def command(self, command):
        if not isinstance(command, dict):
            raise CommandError("Command must be a JSON object.")
        for field in ("action", "preset", "payment_id", "batch_id", "account_id", "network", "operation_id", "currency", "mode"):
            if field in command and not (field == "batch_id" and command[field] is None):
                value = command[field]
                if not isinstance(value, str) or not value or len(value) > 100:
                    raise CommandError(field + " must be a nonempty string of at most 100 characters.")
        with self.lock:
            action = command.get("action")
            self._check_health()
            if self.fault and action != "reset":
                raise CommandError(self.fault, 409)
            if action == "purchase":
                return self._purchase(command)
            if action == "step":
                return {"event": self._step()}
            if action == "capture":
                return self._capture(command.get("payment_id"))
            if action in ("clear", "settle"):
                return self._batch(action, command.get("batch_id"))
            if action == "replay":
                payment = self.payments.get(command.get("payment_id"))
                if not payment:
                    raise CommandError("Select a known payment.", 409)
                self.pending.append(copy.deepcopy(payment))
                return {"payment_id": payment["payment_id"]}
            if action == "mode":
                if command.get("mode") not in ("guided", "automatic"):
                    raise CommandError("Mode must be guided or automatic.")
                self.mode = command["mode"]
            elif action == "pause":
                if not isinstance(command.get("paused"), bool):
                    raise CommandError("paused must be true or false.")
                self.paused = command["paused"]
            elif action == "speed":
                speed = command.get("speed_ms")
                if isinstance(speed, bool) or not isinstance(speed, int) or not 150 <= speed <= 1500:
                    raise CommandError("Speed must be 150–1500 milliseconds.")
                self.speed_ms = speed
            elif action == "reset":
                seed = command.get("seed", self.seed)
                if isinstance(seed, bool) or not isinstance(seed, int) or not 0 <= seed <= 2147483647:
                    raise CommandError("Seed must be an integer between 0 and 2147483647.")
                self._stop_workers()
                self._initialize(seed)
            else:
                raise CommandError("Unknown action.")
            return {"ok": True}

    def _auto_tick(self):
        if self.pending:
            self._step()
            return
        payments = self._merchant_payments()
        authorized = next((pid for pid, item in payments.items() if item["status"] == "AUTHORIZED"), None)
        if authorized:
            self._capture(authorized)
        elif any(item["status"] == "CAPTURED" for item in payments.values()):
            self._batch("clear")
        elif any(item["status"] == "CLEARED" for item in payments.values()):
            self._batch("settle")
        else:
            self._purchase({"amount_cents": self.rng.randint(100, 12000),
                            "account_id": self.rng.choice(("demo-active", "demo-active", "demo-low", "demo-inactive", "unknown-token")),
                            "network": self.rng.choice(("Visa", "Mastercard"))})

    def _automatic_loop(self):
        while not self.stop_event.wait(self.speed_ms / 1000):
            with self.lock:
                self._check_health()
                if self.mode == "automatic" and not self.paused and not self.fault:
                    try:
                        self._auto_tick()
                    except CommandError as error:
                        self._fail(str(error))

    def state(self, after=0, full_trace=False):
        with self.lock:
            self._check_health()
            issuer = self.snapshots.get("issuer", {})
            posted = issuer.get("accounts", self.accounts)["demo-active"]["posted_cents"]
            issuer_payments = issuer.get("payments", {})
            acquirer_payments = self.snapshots.get("acquirer", {}).get("payments", {})
            held = sum(value for pid, value in issuer.get("holds", {}).items()
                       if issuer_payments[pid]["account_id"] == "demo-active")
            outstanding_funding = {
                pid: item for pid, item in issuer_payments.items()
                if item["status"] in ("CLEARED", "SETTLED")
                and acquirer_payments.get(pid, {}).get("status") != "SETTLED"
            }
            balances = dict(posted_cents=posted, held_cents=held, available_cents=posted - held,
                            pending_settlement_cents=sum(item["amount_cents"] for item in outstanding_funding.values()),
                            settlement_in_transit_cents=sum(item["amount_cents"] for item in outstanding_funding.values()
                                                           if item["status"] == "SETTLED"))
            balances.update(self.snapshots.get("acquirer", {}).get("ledger", {
                "merchant_cents": 0, "interchange_cents": 0, "network_fee_cents": 0, "processing_fee_cents": 0}))
            account_balances = {}
            for aid, account in issuer.get("accounts", self.accounts).items():
                account_held = sum(value for pid, value in issuer.get("holds", {}).items()
                                   if issuer_payments[pid]["account_id"] == aid)
                account_balances[aid] = dict(account, held_cents=account_held,
                                             available_cents=account["posted_cents"] - account_held)
            merchant = self._merchant_payments()
            settling_batches = {message.get("batch_id") for message in self.pending
                                if message["type"] in ("SETTLE_REQUEST", "SETTLE_RESULT")}
            payments = []
            for pid, initial in self.payments.items():
                value = dict(identity(initial), status="QUEUED", reason="", fees=None, batch_id=None)
                value.update(merchant.get(pid, {}))
                if value["status"] == "CLEARED" and value.get("batch_id") in settling_batches:
                    value["status"] = "SETTLING"
                payments.append(value)
            result = {"session_id": self.session_id, "mode": self.mode, "paused": self.paused,
                      "seed": self.seed, "speed_ms": self.speed_ms, "pending_count": len(self.pending), "fault": self.fault,
                      "agents": list(self.agents.values()), "payments": payments, "balances": balances,
                      "events": self.events if full_trace else [event for event in self.events if event["seq"] > after],
                      "last_seq": len(self.events), "batches": list(self.snapshots.get("merchant", {}).get("batches", {}).values()),
                      "accounts": issuer.get("accounts", self.accounts), "account_balances": account_balances}
            return copy.deepcopy(result)
