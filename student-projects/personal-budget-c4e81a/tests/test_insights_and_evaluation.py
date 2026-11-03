import unittest
from datetime import date
from decimal import Decimal

from budget_assistant.evaluation import accuracy, dollar_mae_cents, per_class
from budget_assistant.insights import check_narrative, explain, template_explanation
from budget_assistant.report import build_report


def partial_september_report():
    """Packet Q7 verified output: Sept 1-15, PARTIAL, $600, comparison NOT_COMPUTED."""
    r = build_report([], {}, coverage="PARTIAL",
                     coverage_note="another account is unavailable",
                     period_start=date(2026, 9, 1), period_end=date(2026, 9, 15))
    r.net_spending_cents = 60000
    r.category_totals = {"Groceries": 60000}
    r.transaction_count = 5
    return r


BAD = ("Your total spending for September was $600, down 40% from August. "
       "You can safely spend another $400.")


class TestGroundedNarrative(unittest.TestCase):
    def test_packet_q7_bad_narrative_is_caught(self):
        issues = check_narrative(BAD, partial_september_report())
        joined = " | ".join(issues)
        self.assertIn("$400", joined)              # unsupported amount
        self.assertIn("40%", joined)               # unsupported percentage
        self.assertIn("allowance", joined)         # safe-to-spend claim
        self.assertIn("previous period", joined)   # comparison not computed
        self.assertIn("PARTIAL", joined)           # coverage not disclosed
        self.assertIn("whole month", joined)       # claims all of September

    def test_template_replacement_passes_its_own_check(self):
        r = partial_september_report()
        text = template_explanation(r)
        self.assertIn("2026-09-01 to 2026-09-15", text)
        self.assertIn("$600.00", text)
        self.assertIn("partial", text)
        self.assertIn("another account is unavailable", text)
        self.assertEqual(check_narrative(text, r), [])

    def test_bad_generator_falls_back_to_verified_template(self):
        text, src, issues = explain(partial_september_report(), lambda r: BAD)
        self.assertEqual(src, "verified_template")
        self.assertTrue(issues)
        self.assertNotIn("safely", text)

    def test_generator_timeout_still_returns_report_text(self):
        def timeout(_):
            raise TimeoutError("insights service timed out")
        text, src, issues = explain(partial_september_report(), timeout)
        self.assertEqual(src, "verified_template")
        self.assertIn("$600.00", text)
        self.assertIn("timed out", issues[0])

    def test_good_generator_text_is_accepted(self):
        good = ("Partial data: for Sept 1-15 you recorded $600.00 of net spending; "
                "one account was unavailable.")
        _, src, issues = explain(partial_september_report(), lambda r: good)
        self.assertEqual((src, issues), ("generated", []))


class TestPacketQ5Evaluation(unittest.TestCase):
    M = {"Groceries": {"Groceries": 36, "Dining": 4, "Travel": 0},
         "Dining": {"Groceries": 9, "Dining": 21, "Travel": 0},
         "Travel": {"Groceries": 0, "Dining": 0, "Travel": 30}}

    def test_groceries_precision_recall(self):
        g = per_class(self.M, "Groceries")
        self.assertEqual((g["tp"], g["fp"], g["fn"]), (36, 9, 4))
        self.assertEqual(g["precision"], Decimal("0.8"))
        self.assertEqual(g["recall"], Decimal("0.9"))

    def test_accuracy(self):
        self.assertEqual(accuracy(self.M), Decimal("0.87"))

    def test_dollar_mae_and_hidden_cancellation(self):
        correct = {"Groceries": 40000, "Dining": 30000, "Travel": 30000}
        reported = {"Groceries": 55000, "Dining": 15000, "Travel": 30000}
        self.assertEqual(dollar_mae_cents(correct, reported), Decimal("10000"))  # $100
        self.assertEqual(sum(correct.values()), sum(reported.values()))  # both $1,000


if __name__ == "__main__":
    unittest.main()
