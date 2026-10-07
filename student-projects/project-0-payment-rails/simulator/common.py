"""Shared envelopes and arithmetic. No financial decisions live in the supervisor."""

import copy
import hashlib
import json

ROLES = ("payer", "merchant", "gateway", "acquirer", "network", "issuer")
LABELS = {
    "payer": "Payer", "merchant": "Merchant / POS", "gateway": "Gateway / Processor",
    "acquirer": "Acquirer", "network": "Visa / Mastercard (simulated)", "issuer": "Issuer",
}


class PaymentError(ValueError):
    pass


def fees(amount):
    """Round each illustrative fee half up, in integer cents."""
    interchange = (amount * 200 + 5000) // 10000
    network = (amount * 10 + 5000) // 10000
    processing = (amount * 20 + 5000) // 10000 + 10
    return {"interchange_cents": interchange, "network_fee_cents": network,
            "processing_fee_cents": processing,
            "merchant_cents": amount - interchange - network - processing}


def validate_payment(message):
    amount = message.get("amount_cents")
    if isinstance(amount, bool) or not isinstance(amount, int) or not 100 <= amount <= 1000000:
        raise PaymentError("Amount must be integer cents between $1 and $10,000.")
    if message.get("currency") != "USD":
        raise PaymentError("This classroom model accepts USD only.")
    if message.get("network") not in ("Visa", "Mastercard"):
        raise PaymentError("Choose the simulated Visa or Mastercard network.")
    for key in ("payment_id", "operation_id", "account_id", "merchant_id"):
        if not isinstance(message.get(key), str) or not message[key] or len(message[key]) > 100:
            raise PaymentError("Missing or invalid " + key + ".")


def identity(message):
    return {key: message.get(key) for key in
            ("payment_id", "amount_cents", "currency", "account_id", "merchant_id", "network")}


def fingerprint(message):
    value = {key: value for key, value in message.items()
             if key not in ("sender", "recipient", "explanation", "session_id")}
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def batch_digest(items):
    canonical = sorted((identity(item) for item in items), key=lambda item: item["payment_id"])
    return hashlib.sha256(json.dumps(canonical, sort_keys=True).encode()).hexdigest()


def validate_batch(message):
    items = message.get("items")
    if not isinstance(items, list) or not items:
        raise PaymentError("A batch must contain at least one payment.")
    for item in items:
        validate_payment(dict(item, operation_id=message["operation_id"]))
    if len({item["payment_id"] for item in items}) != len(items):
        raise PaymentError("Batch has duplicate payment membership.")
    if sum(item["amount_cents"] for item in items) != message.get("amount_cents"):
        raise PaymentError("Batch total does not match payment amounts.")
    if message.get("digest") != batch_digest(items):
        raise PaymentError("Batch membership or amounts do not match its digest.")
    if not isinstance(message.get("batch_id"), str) or not message["batch_id"]:
        raise PaymentError("Batch identifier is required.")
    stage = "clear" if message["type"].startswith("CLEAR_") else "settle"
    if message["operation_id"] != message["batch_id"] + ":" + stage:
        raise PaymentError("Batch operation ID must identify its batch and stage.")
    return items


def route(message, role, recipient, kind=None, **changes):
    outgoing = copy.deepcopy(message)
    outgoing.update(sender=role, recipient=recipient)
    if kind:
        outgoing["type"] = kind
    outgoing.update(changes)
    return outgoing


def forward(message, role):
    index = ROLES.index(role)
    backwards = message["type"].endswith("_RESULT")
    target = index - 1 if backwards else index + 1
    if not 0 <= target < len(ROLES):
        return []
    return [route(message, role, ROLES[target])]


class Participant:
    """Each process owns this instance, its state, and its operation journal."""

    def __init__(self, role):
        self.role = role
        self.payments = {}
        self.batches = {}
        self.journal = {}

    def handle(self, message):
        key = (message["operation_id"], message["type"])
        signature = fingerprint(message)
        prior = self.journal.get(key)
        if prior:
            if prior[0] != signature:
                return {"outgoing": [], "outcome": "rejected", "reason": "Conflicting operation identifier.",
                        "explanation": "The same operation ID was reused with different content; no state changed."}
            result = copy.deepcopy(prior[1])
            result["explanation"] = "Duplicate operation: returned its recorded result; no financial change. " + result["explanation"]
            result["duplicate"] = True
            return result
        try:
            result = self.apply(message)
        except PaymentError as error:
            result = {"outgoing": [], "outcome": "rejected", "reason": str(error),
                      "explanation": str(error) + " No state changed."}
        self.journal[key] = (signature, copy.deepcopy(result))
        return result

    def apply(self, message):
        return {"outgoing": forward(message, self.role), "outcome": message.get("outcome", "received"),
                "reason": message.get("reason", ""),
                "explanation": LABELS[self.role] + " received and forwarded " + message["type"] + "."}

    def record_payment(self, message):
        pid = message["payment_id"]
        existing = self.payments.get(pid)
        if existing and identity(existing) != identity(message):
            raise PaymentError("Conflicting payment identifier.")
        if existing and message["type"] in ("PURCHASE", "AUTHORIZE") and existing["authorization_operation_id"] != message["operation_id"]:
            raise PaymentError("Conflicting authorization operation for this payment.")
        if not existing:
            self.payments[pid] = dict(identity(message), status="PENDING", reason="", fees=fees(message["amount_cents"]), batch_id=None,
                                     authorization_operation_id=message["operation_id"])
        return self.payments[pid]

    def reconcile(self, message, stage):
        items = validate_batch(message)
        prior = self.batches.get(message["batch_id"])
        if prior and prior["digest"] != message["digest"]:
            raise PaymentError("Conflicting batch membership or amounts.")
        for item in items:
            payment = self.payments.get(item["payment_id"])
            if not payment or identity(payment) != identity(item):
                raise PaymentError("Batch does not match the participant's recorded payment.")
            if payment["status"] not in stage:
                raise PaymentError("Payment is not ready for this batch stage.")
            if payment.get("batch_id") not in (None, message["batch_id"]):
                raise PaymentError("Payment already belongs to another batch.")
        return items

    def snapshot(self):
        return {"payments": copy.deepcopy(self.payments), "batches": copy.deepcopy(self.batches)}
