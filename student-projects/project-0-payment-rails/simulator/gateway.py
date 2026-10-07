"""The processor checks the envelope and forwards the merchant's messages."""
from .common import Participant, validate_batch, validate_payment


class Gateway(Participant):
    def __init__(self):
        super().__init__("gateway")

    def apply(self, message):
        if message["type"] == "AUTHORIZE":
            validate_payment(message)
            self.record_payment(message)
        elif message["type"] in ("CLEAR_REQUEST", "SETTLE_REQUEST"):
            validate_batch(message)
        return super().apply(message)
