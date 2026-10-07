"""Financial invariants and hostile/repeated envelopes, without networking."""
import copy
import json
from pathlib import Path
import unittest

from simulator.acquirer import Acquirer
from simulator.common import batch_digest, fees, identity
from simulator.issuer import Issuer
from simulator.merchant import Merchant

ACCOUNTS = json.loads((Path(__file__).resolve().parents[1] / "data/accounts.json").read_text())


def authorization(pid="P0001", amount=5000, account="demo-active", **extra):
    return dict({"payment_id": pid, "operation_id": pid + ":authorize", "sender": "network", "recipient": "issuer",
                 "type": "AUTHORIZE", "amount_cents": amount, "currency": "USD", "account_id": account,
                 "merchant_id": "campus-cafe", "network": "Visa", "outcome": "", "reason": ""}, **extra)


def batch(items, kind="CLEAR_REQUEST", bid="B0001"):
    items = [identity(item) for item in items]
    return {"payment_id": items[0]["payment_id"], "operation_id": bid + (":clear" if kind.startswith("CLEAR_") else ":settle"),
            "sender": "network", "recipient": "issuer", "type": kind, "amount_cents": sum(item["amount_cents"] for item in items),
            "currency": "USD", "batch_id": bid, "items": items, "digest": batch_digest(items), "outcome": "", "reason": ""}


class FinancialRules(unittest.TestCase):
    def setUp(self):
        self.issuer = Issuer(ACCOUNTS)

    def test_authorize_hold_capture_clear_settle_and_exact_fees(self):
        message = authorization()
        result = self.issuer.handle(message)
        self.assertEqual(result["outcome"], "approved")
        self.assertEqual(self.issuer.accounts["demo-active"]["posted_cents"], 50000)
        self.assertEqual(self.issuer.holds, {"P0001": 5000})
        merchant = Merchant()
        merchant.handle(dict(message, sender="payer", recipient="merchant"))
        merchant.handle(dict(result["outgoing"][0], recipient="merchant"))
        merchant.handle(dict(message, type="CAPTURE", operation_id="P0001:capture"))
        self.assertEqual(merchant.payments["P0001"]["status"], "CAPTURED")
        self.assertEqual(self.issuer.holds, {"P0001": 5000})
        clearing = batch([message])
        self.assertEqual(self.issuer.handle(clearing)["outcome"], "approved")
        self.assertEqual(self.issuer.holds, {})
        self.assertEqual(self.issuer.accounts["demo-active"]["posted_cents"], 45000)
        self.assertEqual(self.issuer.pending, {"P0001": 5000})
        self.assertEqual(self.issuer.handle(batch([message], "SETTLE_REQUEST"))["outcome"], "approved")
        self.assertEqual(self.issuer.pending, {})
        self.assertEqual(fees(5000), {"interchange_cents": 100, "network_fee_cents": 5,
                                     "processing_fee_cents": 20, "merchant_cents": 4875})

    def test_declines_do_not_create_holds_or_change_posted_balance(self):
        for index, (amount, account, reason) in enumerate(((60000, "demo-active", "Insufficient"),
                (5000, "demo-inactive", "inactive"), (5000, "unknown-token", "Unknown"))):
            result = self.issuer.handle(authorization("P" + str(index), amount, account))
            self.assertEqual(result["outcome"], "declined")
            self.assertIn(reason, result["reason"])
        self.assertEqual(self.issuer.holds, {})
        self.assertEqual(self.issuer.accounts, ACCOUNTS)

    def test_duplicate_authorization_and_conflicting_ids(self):
        message = authorization()
        self.issuer.handle(message)
        snapshot = self.issuer.snapshot()
        self.assertTrue(self.issuer.handle(copy.deepcopy(message))["duplicate"])
        self.assertEqual(self.issuer.snapshot(), snapshot)
        conflict = self.issuer.handle(dict(message, amount_cents=5001))
        self.assertEqual(conflict["outcome"], "rejected")
        self.assertEqual(self.issuer.snapshot(), snapshot)
        result = self.issuer.handle(dict(message, operation_id="different-auth-id"))
        self.assertEqual(result["outcome"], "rejected")
        self.assertEqual(self.issuer.snapshot(), snapshot)

    def test_competing_authorizations_use_available_funds(self):
        self.assertEqual(self.issuer.handle(authorization("P1", 30000))["outcome"], "approved")
        self.assertEqual(self.issuer.handle(authorization("P2", 30000))["outcome"], "declined")
        self.assertEqual(sum(self.issuer.holds.values()), 30000)
        self.assertEqual(self.issuer.accounts["demo-active"]["posted_cents"], 50000)

    def test_invalid_inputs_are_rejected_before_financial_mutation(self):
        for index, changes in enumerate(({"amount_cents": True}, {"amount_cents": -1}, {"amount_cents": 0},
                {"amount_cents": 12.5}, {"amount_cents": 99}, {"currency": "EUR"}, {"network": "RealNetwork"},
                {"account_id": ""})):
            result = self.issuer.handle(authorization("Invalid" + str(index), **changes))
            self.assertEqual(result["outcome"], "rejected")
        self.assertEqual(self.issuer.payments, {})
        self.assertEqual(self.issuer.accounts, ACCOUNTS)

    def test_out_of_order_stages_and_batch_tampering_are_atomic(self):
        messages = [authorization("P1"), authorization("P2")]
        for message in messages:
            self.issuer.handle(message)
        unchanged = self.issuer.snapshot()
        self.assertEqual(self.issuer.handle(batch(messages, "SETTLE_REQUEST"))["outcome"], "rejected")
        self.assertEqual(self.issuer.snapshot(), unchanged)
        for index, change in enumerate(("total", "member", "duplicate", "identity")):
            tampered = batch(messages, bid="Bad" + str(index))
            if change == "total":
                tampered["amount_cents"] += 1
            elif change == "member":
                tampered["items"][1]["amount_cents"] += 1
            elif change == "duplicate":
                tampered["items"][1] = tampered["items"][0]
            else:
                tampered["items"][1]["account_id"] = "demo-inactive"
                tampered["digest"] = batch_digest(tampered["items"])
            self.assertEqual(self.issuer.handle(tampered)["outcome"], "rejected")
            self.assertEqual(self.issuer.snapshot(), unchanged)

    def test_clearing_and_settlement_duplicates_post_and_credit_once(self):
        message = authorization()
        acquirer = Acquirer()
        auth_result = self.issuer.handle(message)["outgoing"][0]
        acquirer.handle(message)
        acquirer.handle(auth_result)
        clearing = batch([message])
        clear_result = self.issuer.handle(clearing)["outgoing"][0]
        acquirer.handle(clear_result)
        before = self.issuer.snapshot()
        self.assertTrue(self.issuer.handle(clearing)["duplicate"])
        self.assertEqual(self.issuer.snapshot(), before)
        settlement = batch([message], "SETTLE_REQUEST")
        settle_result = self.issuer.handle(settlement)["outgoing"][0]
        acquirer.handle(settle_result)
        ledger = dict(acquirer.ledger)
        self.assertTrue(acquirer.handle(settle_result)["duplicate"])
        self.assertTrue(self.issuer.handle(settlement)["duplicate"])
        self.assertEqual(acquirer.ledger, ledger)
        self.assertEqual(sum(ledger.values()), 5000)
        self.assertEqual(ledger["merchant_cents"], 4875)
        self.assertEqual(self.issuer.accounts["demo-active"]["posted_cents"], 45000)

    def test_capture_requires_authorization_and_is_idempotent(self):
        merchant = Merchant()
        message = authorization()
        capture = dict(message, type="CAPTURE", operation_id="P0001:capture")
        self.assertEqual(merchant.handle(capture)["outcome"], "rejected")
        self.assertEqual(merchant.payments, {})
        merchant = Merchant()
        merchant.handle(message)
        self.assertEqual(merchant.handle(capture)["outcome"], "rejected")
        merchant.handle(dict(message, type="AUTH_RESULT", outcome="approved", reason="approved"))
        # A rejected operation is recorded; use a new operation for the valid later attempt.
        valid_capture = dict(capture, operation_id="P0001:capture-after-approval")
        self.assertEqual(merchant.handle(valid_capture)["outcome"], "captured")
        self.assertTrue(merchant.handle(valid_capture)["duplicate"])

    def test_fee_rounding_is_per_transaction_and_conserves_cents(self):
        self.assertEqual(fees(500)["network_fee_cents"], 1)
        self.assertEqual(fees(250)["network_fee_cents"], 0)
        self.assertEqual(fees(250)["processing_fee_cents"], 11)
        for amount in (100, 101, 249, 250, 499, 500, 999, 5000, 1000000):
            self.assertEqual(sum(fees(amount).values()), amount)
            self.assertGreaterEqual(fees(amount)["merchant_cents"], 0)


if __name__ == "__main__":
    unittest.main()
