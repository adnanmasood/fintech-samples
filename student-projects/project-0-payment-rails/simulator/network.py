"""A fictional scheme routes messages and reconciles the recorded batch."""
from .common import Participant, PaymentError, identity, validate_batch


class Network(Participant):
    def __init__(self):
        super().__init__("network")

    def apply(self, message):
        kind = message["type"]
        if kind == "AUTHORIZE":
            self.record_payment(message)
        elif kind == "AUTH_RESULT":
            self.record_payment(message)["status"] = "AUTHORIZED" if message["outcome"] == "approved" else "DECLINED"
        elif kind in ("CLEAR_REQUEST", "SETTLE_REQUEST"):
            self.reconcile(message, ("AUTHORIZED",) if kind == "CLEAR_REQUEST" else ("CLEARED",))
        elif kind in ("CLEAR_RESULT", "SETTLE_RESULT") and message["outcome"] == "approved":
            self.reconcile(message, ("AUTHORIZED",) if kind == "CLEAR_RESULT" else ("CLEARED",))
            status = "CLEARED" if kind == "CLEAR_RESULT" else "SETTLED"
            self.batches[message["batch_id"]] = {"digest": message["digest"], "status": status}
            for item in message["items"]:
                self.payments[item["payment_id"]].update(status=status, batch_id=message["batch_id"])
        return super().apply(message)
