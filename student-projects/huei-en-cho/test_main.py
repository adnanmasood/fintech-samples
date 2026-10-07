"""Unit tests for the toy fraud screening demo in main.py."""

import unittest

from main import (
    Transaction,
    decide,
    get_mock_risk_score,
    screen_transaction,
)


class TestDecisionThresholds(unittest.TestCase):
    """Tests for the decide() function in isolation from scoring."""

    def test_low_score_is_approved(self):
        result = decide(0.05)
        self.assertEqual(result.decision, "APPROVE")
        self.assertTrue(result.reason)

    def test_score_just_below_approve_threshold_is_approved(self):
        result = decide(0.29)
        self.assertEqual(result.decision, "APPROVE")

    def test_score_at_approve_threshold_is_challenged(self):
        # 0.30 is inclusive on the CHALLENGE side per the spec.
        result = decide(0.30)
        self.assertEqual(result.decision, "CHALLENGE")

    def test_medium_score_is_challenged(self):
        result = decide(0.45)
        self.assertEqual(result.decision, "CHALLENGE")
        self.assertTrue(result.reason)

    def test_score_just_below_decline_threshold_is_challenged(self):
        result = decide(0.69)
        self.assertEqual(result.decision, "CHALLENGE")

    def test_score_at_decline_threshold_is_declined(self):
        # 0.70 is inclusive on the DECLINE side per the spec.
        result = decide(0.70)
        self.assertEqual(result.decision, "DECLINE")

    def test_high_score_is_declined(self):
        result = decide(0.92)
        self.assertEqual(result.decision, "DECLINE")
        self.assertTrue(result.reason)

    def test_missing_score_is_challenged_with_fallback_reason(self):
        result = decide(None)
        self.assertEqual(result.decision, "CHALLENGE")
        self.assertIn("unavailable", result.reason.lower())


class TestMockRiskScore(unittest.TestCase):
    """Tests for the mock scorer, kept separate from decision rules."""

    def test_known_transaction_returns_expected_score(self):
        self.assertEqual(get_mock_risk_score("txn-low-risk"), 0.05)
        self.assertEqual(get_mock_risk_score("txn-medium-risk"), 0.45)
        self.assertEqual(get_mock_risk_score("txn-high-risk"), 0.92)

    def test_unknown_transaction_returns_none(self):
        self.assertIsNone(get_mock_risk_score("txn-does-not-exist"))


class TestScreenTransaction(unittest.TestCase):
    """End-to-end tests wiring scoring and decisioning together."""

    def _make_transaction(self, transaction_id: str) -> Transaction:
        return Transaction(
            transaction_id=transaction_id,
            card_last4="0000",
            amount=100.00,
            currency="USD",
            merchant="Fictional Test Merchant",
        )

    def test_low_risk_transaction_is_approved(self):
        result = screen_transaction(self._make_transaction("txn-low-risk"))
        self.assertEqual(result.decision, "APPROVE")

    def test_medium_risk_transaction_is_challenged(self):
        result = screen_transaction(self._make_transaction("txn-medium-risk"))
        self.assertEqual(result.decision, "CHALLENGE")

    def test_high_risk_transaction_is_declined(self):
        result = screen_transaction(self._make_transaction("txn-high-risk"))
        self.assertEqual(result.decision, "DECLINE")

    def test_missing_score_transaction_is_challenged(self):
        result = screen_transaction(self._make_transaction("txn-missing-score"))
        self.assertEqual(result.decision, "CHALLENGE")

    def test_every_result_has_decision_and_reason(self):
        for transaction_id in (
            "txn-low-risk",
            "txn-medium-risk",
            "txn-high-risk",
            "txn-missing-score",
        ):
            result = screen_transaction(self._make_transaction(transaction_id))
            self.assertTrue(result.decision)
            self.assertTrue(result.reason)


if __name__ == "__main__":
    unittest.main()
