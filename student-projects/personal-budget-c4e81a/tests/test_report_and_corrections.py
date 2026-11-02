import tempfile
import unittest
from decimal import Decimal
from pathlib import Path

from budget_assistant.categorize import decide_all, decide_category
from budget_assistant.ingest import parse_csv_file, parse_csv_text
from budget_assistant.models import Transaction
from budget_assistant.report import build_report
from budget_assistant.service import import_csv, load_budgets, user_report
from budget_assistant.store import AccessError, JsonStore

DATA = Path(__file__).resolve().parent.parent / "data"


def report_for(csv_path, budgets=None, **kw):
    r = parse_csv_file(csv_path)
    return build_report(r.valid, decide_all(r.valid), budgets or {}, **kw)


class TestPacketQ4SpendingPolicy(unittest.TestCase):
    """Packet Q4: which money movements count as spending?"""

    def setUp(self):
        self.r = report_for(DATA / "packet_q4_month.csv", {"Groceries": 25000})

    def test_category_totals(self):
        self.assertEqual(self.r.category_totals,
                         {"Housing": 120000, "Groceries": 18000, "Dining": 8000})

    def test_net_spending_and_income_minus_spending(self):
        self.assertEqual(self.r.net_spending_cents, 146000)
        self.assertEqual(self.r.income_cents, 300000)
        self.assertEqual(self.r.income_minus_spending_cents, 154000)

    def test_transfer_and_card_payment_are_not_spending(self):
        self.assertEqual(self.r.transfers_cents, 50000)
        self.assertEqual(self.r.card_payments_cents, 8000)
        # Naive "every checking outflow" view would be 1200+200+500+80 = 1980
        naive = 120000 + 20000 + 50000 + 8000
        self.assertEqual(naive, 198000)
        self.assertNotEqual(naive, self.r.net_spending_cents)

    def test_grocery_budget(self):
        g = self.r.budget_lines[0]
        self.assertEqual((g.spent_cents, g.remaining_cents, g.pct_used, g.status),
                         (18000, 7000, Decimal("72.0"), "OK"))

    def test_over_budget_status(self):
        r = report_for(DATA / "packet_q4_month.csv", {"Groceries": 15000})
        g = r.budget_lines[0]
        self.assertEqual((g.remaining_cents, g.status), (-3000, "OVER"))


class TestBoundaryCases(unittest.TestCase):
    def test_exactly_at_budget_is_not_over(self):
        t = [Transaction("X", __import__("datetime").date(2026, 9, 1), "CITY MARKET", 25000)]
        r = build_report(t, decide_all(t), {"Groceries": 25000})
        self.assertEqual((r.budget_lines[0].remaining_cents, r.budget_lines[0].status),
                         (0, "NEAR_LIMIT"))

    def test_refund_larger_than_purchases_gives_negative_category(self):
        r = parse_csv_text("transaction_id,date,description,amount,type\n"
                           "X,2026-09-01,CITY MARKET,10.00,refund\n")
        rep = build_report(r.valid, decide_all(r.valid))
        self.assertEqual(rep.category_totals["Groceries"], -1000)

    def test_unknown_merchant_stays_visible(self):
        r = parse_csv_text("transaction_id,date,description,amount\nX,2026-09-01,LUNA BOOKSHOP,9.99\n")
        rep = build_report(r.valid, decide_all(r.valid))
        self.assertEqual(rep.uncategorized_ids, ["X"])
        self.assertEqual(rep.category_totals["Uncategorized"], 999)

    def test_empty_input(self):
        rep = build_report([], {})
        self.assertEqual((rep.net_spending_cents, rep.category_totals), (0, {}))


class TestClassifierBoundary(unittest.TestCase):
    t = Transaction("X", __import__("datetime").date(2026, 9, 1), "NEW MERCHANT", 100)

    def test_confident_prediction_used(self):
        d = decide_category(self.t, classifier=lambda s: ("Dining", 0.93))
        self.assertEqual((d.category, d.source), ("Dining", "classifier"))

    def test_uncertain_prediction_goes_to_review(self):
        d = decide_category(self.t, classifier=lambda s: ("Dining", 0.55))
        self.assertEqual((d.category, d.source), ("Uncategorized", "uncategorized"))

    def test_classifier_outage_does_not_break(self):
        def boom(_):
            raise TimeoutError("timeout")
        self.assertEqual(decide_category(self.t, classifier=boom).category, "Uncategorized")

    def test_rule_map_beats_classifier(self):
        t = Transaction("Y", self.t.date, "CITY MARKET", 100)
        d = decide_category(t, classifier=lambda s: ("Dining", 0.99))
        self.assertEqual((d.category, d.source), ("Groceries", "rule_map"))


class TestPacketQ6Corrections(unittest.TestCase):
    """Packet Q6: correct T2 only; persists across restart and rerun;
    T1 and another customer's City Market purchases are unchanged."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "store.json"
        self.budgets = {}
        text = (DATA / "packet_q6_city_market.csv").read_text()
        s = JsonStore(self.path)
        import_csv(s, "cust-a", text)
        import_csv(s, "cust-b", text)
        self.store = s

    def tearDown(self):
        self.tmp.cleanup()

    def totals(self, store, user):
        return user_report(store, user, self.budgets)[0]

    def test_before_and_after_totals(self):
        before = self.totals(self.store, "cust-a")
        self.assertEqual(before.category_totals, {"Groceries": 10000, "Travel": 3000})
        self.store.set_override("cust-a", "T2", "Dining", previous="Groceries")
        after = self.totals(self.store, "cust-a")
        self.assertEqual(after.category_totals,
                         {"Groceries": 4000, "Dining": 6000, "Travel": 3000})
        self.assertEqual(before.net_spending_cents, after.net_spending_cents, 13000)

    def test_correction_survives_restart_and_reimport(self):
        self.store.set_override("cust-a", "T2", "Dining")
        restarted = JsonStore(self.path)  # simulate application restart
        import_csv(restarted, "cust-a", (DATA / "packet_q6_city_market.csv").read_text())
        rep, decisions, _ = user_report(restarted, "cust-a", self.budgets)
        self.assertEqual(decisions["T2"].source, "override")
        self.assertEqual(decisions["T1"].category, "Groceries")  # T1 unchanged
        self.assertEqual(rep.category_totals["Dining"], 6000)
        # original amount and description preserved
        t2 = [t for t in restarted.transactions("cust-a") if t.txn_id == "T2"][0]
        self.assertEqual((t2.amount_cents, t2.description), (6000, "CITY MARKET"))
        self.assertEqual(restarted.corrections_log("cust-a")[0]["to"], "Dining")

    def test_other_customer_unaffected(self):
        self.store.set_override("cust-a", "T2", "Dining")
        self.store.set_merchant_rule("cust-a", "CITY MARKET", "Dining")
        b = self.totals(self.store, "cust-b")
        self.assertEqual(b.category_totals, {"Groceries": 10000, "Travel": 3000})

    def test_explicit_merchant_rule_applies_to_that_users_future_txns(self):
        self.store.set_merchant_rule("cust-a", "CITY MARKET", "Dining")
        import_csv(self.store, "cust-a",
                   "transaction_id,date,description,amount\nT9,2026-09-20,CITY MARKET,5.00\n")
        _, d, _ = user_report(self.store, "cust-a", self.budgets)
        self.assertEqual((d["T9"].category, d["T9"].source), ("Dining", "user_rule"))

    def test_cannot_correct_another_customers_transaction(self):
        import_csv(self.store, "cust-b",
                   "transaction_id,date,description,amount\nB-ONLY,2026-09-01,CAFE,1\n")
        with self.assertRaises(AccessError):
            self.store.set_override("cust-a", "B-ONLY", "Dining")
        self.assertNotIn("B-ONLY", [t.txn_id for t in self.store.transactions("cust-a")])


class TestPacketQ7RepeatedImport(unittest.TestCase):
    def test_same_file_twice_does_not_double_count(self):
        with tempfile.TemporaryDirectory() as d:
            s = JsonStore(Path(d) / "s.json")
            text = (DATA / "packet_q7_repeat.csv").read_text()
            first = import_csv(s, "u", text)
            second = import_csv(s, "u", text)
            self.assertEqual((len(first.stored.added), len(first.parsed.errors)), (2, 1))
            self.assertEqual((len(second.stored.added), len(second.stored.already_imported)), (0, 2))
            rep = user_report(s, "u", {})[0]
            self.assertEqual(rep.net_spending_cents, 5000)  # still $50, not $100
            self.assertEqual(len(rep.row_errors), 1)  # 'twenty' still reported

    def test_same_id_different_data_is_a_conflict_not_overwrite(self):
        with tempfile.TemporaryDirectory() as d:
            s = JsonStore(Path(d) / "s.json")
            import_csv(s, "u", "transaction_id,date,description,amount\nZ,2026-09-01,CAFE,5\n")
            out = import_csv(s, "u", "transaction_id,date,description,amount\nZ,2026-09-01,CAFE,7\n")
            self.assertEqual(out.stored.conflicts, ["Z"])
            self.assertEqual(s.transactions("u")[0].amount_cents, 500)


class TestSampleData(unittest.TestCase):
    def test_sample_file_totals_reconcile(self):
        r = report_for(DATA / "sample_transactions.csv", load_budgets(DATA / "budgets.json"))
        self.assertEqual(r.net_spending_cents, 169549)
        self.assertEqual(sum(r.category_totals.values()), r.net_spending_cents)
        self.assertEqual(r.category_totals["Groceries"], 20335)


if __name__ == "__main__":
    unittest.main()
