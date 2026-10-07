"""The issuing bank serializes account checks, holds, debits, and obligations."""
import copy
from .common import Participant, PaymentError, route, validate_payment


class Issuer(Participant):
    def __init__(self, accounts):
        super().__init__("issuer")
        self.accounts = copy.deepcopy(accounts)
        self.holds = {}
        self.pending = {}

    def apply(self, message):
        kind = message["type"]
        if kind == "AUTHORIZE":
            validate_payment(message)
            payment = self.record_payment(message)
            account = self.accounts.get(message["account_id"])
            held = sum(amount for pid, amount in self.holds.items()
                       if self.payments[pid]["account_id"] == message["account_id"])
            if account is None:
                reason = "Unknown synthetic payment token."
            elif not account["active"]:
                reason = "Account is inactive."
            elif account["posted_cents"] - held < message["amount_cents"]:
                reason = "Insufficient available funds."
            else:
                reason = "Funds reserved; posted balance is unchanged."
            approved = account is not None and account["active"] and account["posted_cents"] - held >= message["amount_cents"]
            outcome = "approved" if approved else "declined"
            payment.update(status="AUTHORIZED" if approved else "DECLINED", reason=reason)
            if approved:
                self.holds[message["payment_id"]] = message["amount_cents"]
            return {"outgoing": [route(message, self.role, "network", "AUTH_RESULT", outcome=outcome, reason=reason)],
                    "outcome": outcome, "reason": reason,
                    "explanation": "The issuer checks the account and available funds. " + reason}
        if kind in ("CLEAR_REQUEST", "SETTLE_REQUEST"):
            items = self.reconcile(message, ("AUTHORIZED",) if kind == "CLEAR_REQUEST" else ("CLEARED",))
            # Validate every member before changing any account or obligation.
            for item in items:
                if kind == "CLEAR_REQUEST" and self.holds.get(item["payment_id"]) != item["amount_cents"]:
                    raise PaymentError("Clearing amount does not match the authorization hold.")
                if kind == "SETTLE_REQUEST" and self.pending.get(item["payment_id"]) != item["amount_cents"]:
                    raise PaymentError("Settlement amount does not match the cleared obligation.")
            status = "CLEARED" if kind == "CLEAR_REQUEST" else "SETTLED"
            for item in items:
                pid = item["payment_id"]
                if kind == "CLEAR_REQUEST":
                    self.accounts[item["account_id"]]["posted_cents"] -= self.holds.pop(pid)
                    self.pending[pid] = item["amount_cents"]
                else:
                    self.pending.pop(pid)
                self.payments[pid].update(status=status, batch_id=message["batch_id"])
            self.batches[message["batch_id"]] = {"digest": message["digest"], "status": status}
            explanation = ("Clearing replaces each hold with one posted debit and an unsettled obligation."
                           if kind == "CLEAR_REQUEST" else "The issuer releases the reconciled obligation into the settlement return path.")
            result_kind = "CLEAR_RESULT" if kind == "CLEAR_REQUEST" else "SETTLE_RESULT"
            return {"outgoing": [route(message, self.role, "network", result_kind, outcome="approved", reason="Batch reconciled.")],
                    "outcome": "approved", "reason": "Batch reconciled.", "explanation": explanation}
        raise PaymentError("Unexpected issuer message.")

    def snapshot(self):
        return dict(super().snapshot(), accounts=copy.deepcopy(self.accounts), holds=dict(self.holds), pending=dict(self.pending))
