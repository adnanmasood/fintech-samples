import json
import unittest
from pathlib import Path

from logic import screen_transaction


def tx(**overrides):
    base = {"transaction_id": "T1", "amount_cents": 1000, "card_blocked": False,
            "risk_score": 0.10, "model_timeout": False}
    base.update(overrides)
    return base


class ScreenTransactionTests(unittest.TestCase):
    def check(self, status, reason, **overrides):
        r = screen_transaction(tx(**overrides))
        self.assertEqual((r["status"], r["reason"]), (status, reason))
        self.assertEqual(r["transaction_id"], overrides.get("transaction_id", "T1"))

    def test_low_risk(self):
        self.check("APPROVE", "LOW_RISK")

    def test_zero_score(self):
        self.check("APPROVE", "LOW_RISK", risk_score=0)

    def test_boundary_020(self):
        self.check("CHALLENGE", "VERIFICATION_REQUIRED", risk_score=0.20)

    def test_just_below_020(self):
        self.check("APPROVE", "LOW_RISK", risk_score=0.1999)

    def test_middle(self):
        self.check("CHALLENGE", "VERIFICATION_REQUIRED", risk_score=0.5)

    def test_just_below_080(self):
        self.check("CHALLENGE", "VERIFICATION_REQUIRED", risk_score=0.7999)

    def test_boundary_080(self):
        self.check("DECLINE", "HIGH_RISK", risk_score=0.80)

    def test_score_one(self):
        self.check("DECLINE", "HIGH_RISK", risk_score=1)

    def test_timeout_with_low_score(self):
        self.check("CHALLENGE", "MODEL_UNAVAILABLE", model_timeout=True, risk_score=0.10)

    def test_null_score(self):
        self.check("CHALLENGE", "MODEL_UNAVAILABLE", risk_score=None)

    def test_missing_score_key(self):
        t = tx()
        del t["risk_score"]
        self.assertEqual(screen_transaction(t)["reason"], "MODEL_UNAVAILABLE")

    def test_blocked_with_low_score(self):
        self.check("DECLINE", "CARD_BLOCKED", card_blocked=True, risk_score=0.01)

    def test_blocked_with_timeout(self):
        self.check("DECLINE", "CARD_BLOCKED", card_blocked=True, model_timeout=True)

    def test_blocked_with_null_score(self):
        self.check("DECLINE", "CARD_BLOCKED", card_blocked=True, risk_score=None)

    def test_invalid_scores(self):
        for bad in (-1, 1.1, float("nan"), float("inf"), "0.5", True):
            with self.subTest(score=bad):
                self.check("INVALID_INPUT", "INVALID_SCORE", risk_score=bad)

    def test_timeout_wins_over_invalid_score(self):
        self.check("CHALLENGE", "MODEL_UNAVAILABLE", model_timeout=True, risk_score=5)

    def test_blank_id(self):
        for bad in ("", "   ", None, 123):
            with self.subTest(tid=bad):
                self.check("INVALID_INPUT", "INVALID_TRANSACTION_ID", transaction_id=bad)

    def test_invalid_amounts(self):
        for bad in (0, -5, 10.5, 10.0, True, "100", None):
            with self.subTest(amount=bad):
                self.check("INVALID_INPUT", "INVALID_AMOUNT", amount_cents=bad)

    def test_invalid_flags(self):
        self.check("INVALID_INPUT", "INVALID_CARD_BLOCKED", card_blocked="yes")
        self.check("INVALID_INPUT", "INVALID_MODEL_TIMEOUT", model_timeout=1)

    def test_validation_before_block(self):
        self.check("INVALID_INPUT", "INVALID_AMOUNT", card_blocked=True, amount_cents=0)

    def test_non_dict(self):
        r = screen_transaction("nope")
        self.assertEqual(r["status"], "INVALID_INPUT")

    def test_sample_data(self):
        expected = [("APPROVE", "LOW_RISK"), ("CHALLENGE", "MODEL_UNAVAILABLE"),
                    ("DECLINE", "CARD_BLOCKED"), ("CHALLENGE", "VERIFICATION_REQUIRED"),
                    ("DECLINE", "HIGH_RISK"), ("INVALID_INPUT", "INVALID_SCORE"),
                    ("INVALID_INPUT", "INVALID_TRANSACTION_ID"),
                    ("INVALID_INPUT", "INVALID_AMOUNT")]
        path = Path(__file__).parent.parent / "data" / "sample_transactions.json"
        samples = json.loads(path.read_text())
        got = [(r["status"], r["reason"])
               for r in (screen_transaction(s["transaction"]) for s in samples)]
        self.assertEqual(got, expected)


if __name__ == "__main__":
    unittest.main()
