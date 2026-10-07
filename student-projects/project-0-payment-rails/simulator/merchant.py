"""The POS requests authorization, captures approved sales, and creates batches."""
import copy
from .common import Participant, PaymentError, forward, route, validate_payment


class Merchant(Participant):
    def __init__(self):
        super().__init__("merchant")

    def apply(self, message):
        kind = message["type"]
        if kind == "AUTHORIZE":
            validate_payment(message)
            self.record_payment(message)
        elif kind == "AUTH_RESULT":
            payment = self.record_payment(message)
            if payment["status"] in ("PENDING", "AUTHORIZED", "DECLINED"):
                payment.update(status="AUTHORIZED" if message["outcome"] == "approved" else "DECLINED", reason=message["reason"])
        elif kind == "CAPTURE":
            if message["payment_id"] not in self.payments:
                raise PaymentError("Capture requires a known payment.")
            payment = self.record_payment(message)
            if payment["status"] != "AUTHORIZED":
                raise PaymentError("Full capture requires an approved authorization.")
            payment["status"] = "CAPTURED"
            return {"outgoing": [], "outcome": "captured", "reason": "",
                    "explanation": "The merchant confirms the entire sale. The issuer hold remains; no debit posts yet."}
        elif kind in ("CLEAR_REQUEST", "SETTLE_REQUEST"):
            stage = ("CAPTURED",) if kind == "CLEAR_REQUEST" else ("CLEARED",)
            self.reconcile(message, stage)
            self.batches.setdefault(message["batch_id"], {"batch_id": message["batch_id"], "digest": message["digest"],
                "items": copy.deepcopy(message["items"]), "amount_cents": message["amount_cents"], "status": "CLEARING"})
            for item in message["items"]:
                self.payments[item["payment_id"]]["batch_id"] = message["batch_id"]
        elif kind in ("CLEAR_RESULT", "SETTLE_RESULT"):
            if message["outcome"] == "approved":
                self.reconcile(message, ("CAPTURED",) if kind == "CLEAR_RESULT" else ("CLEARED",))
                status = "CLEARED" if kind == "CLEAR_RESULT" else "SETTLED"
                for item in message["items"]:
                    self.payments[item["payment_id"]]["status"] = status
                self.batches[message["batch_id"]]["status"] = status
            return {"outgoing": [], "outcome": message["outcome"], "reason": message["reason"],
                    "explanation": "The merchant receives the reconciled " + ("clearing" if kind == "CLEAR_RESULT" else "settlement") + " result."}
        else:
            raise PaymentError("Unexpected merchant message.")
        return super().apply(message)
