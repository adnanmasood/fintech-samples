"""The acquirer owns merchant proceeds and illustrative fee allocations."""
from .common import Participant, fees, validate_batch


class Acquirer(Participant):
    def __init__(self):
        super().__init__("acquirer")
        self.ledger = {"merchant_cents": 0, "interchange_cents": 0, "network_fee_cents": 0, "processing_fee_cents": 0}

    def apply(self, message):
        kind = message["type"]
        if kind == "AUTHORIZE":
            self.record_payment(message)
        elif kind == "AUTH_RESULT":
            self.record_payment(message)["status"] = "AUTHORIZED" if message["outcome"] == "approved" else "DECLINED"
        elif kind in ("CLEAR_REQUEST", "SETTLE_REQUEST"):
            self.reconcile(message, ("AUTHORIZED",) if kind == "CLEAR_REQUEST" else ("CLEARED",))
        elif kind in ("CLEAR_RESULT", "SETTLE_RESULT") and message["outcome"] == "approved":
            validate_batch(message)
            self.reconcile(message, ("AUTHORIZED",) if kind == "CLEAR_RESULT" else ("CLEARED",))
            status = "CLEARED" if kind == "CLEAR_RESULT" else "SETTLED"
            for item in message["items"]:
                self.payments[item["payment_id"]].update(status=status, batch_id=message["batch_id"])
                if kind == "SETTLE_RESULT":
                    for key, value in fees(item["amount_cents"]).items():
                        self.ledger[key] += value
            self.batches[message["batch_id"]] = {"digest": message["digest"], "status": status}
        return super().apply(message)

    def snapshot(self):
        return dict(super().snapshot(), ledger=dict(self.ledger))
