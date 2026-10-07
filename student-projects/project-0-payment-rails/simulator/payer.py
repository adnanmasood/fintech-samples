"""The payer presents a fictional token and receives the merchant's answer."""
from .common import Participant, PaymentError, route, validate_payment


class Payer(Participant):
    def __init__(self):
        super().__init__("payer")

    def apply(self, message):
        if message["type"] == "PURCHASE":
            validate_payment(message)
            self.record_payment(message)
            return {"outgoing": [route(message, self.role, "merchant", "AUTHORIZE")],
                    "outcome": "submitted", "reason": "",
                    "explanation": "The payer presents a synthetic debit token for this purchase."}
        if message["type"] == "AUTH_RESULT":
            payment = self.record_payment(message)
            payment.update(status="AUTHORIZED" if message["outcome"] == "approved" else "DECLINED", reason=message["reason"])
            return {"outgoing": [], "outcome": message["outcome"], "reason": message["reason"],
                    "explanation": "The payer sees the final " + message["outcome"] + " answer from the merchant."}
        raise PaymentError("Unexpected payer message.")
