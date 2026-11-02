import unittest
from decimal import Decimal

from budget_assistant.ingest import parse_csv_text
from budget_assistant.money import AmountError, format_cents, parse_amount_cents, percent

HEADER = "transaction_id,date,description,amount,type\n"


class TestMoney(unittest.TestCase):
    def test_valid_amounts_become_exact_cents(self):
        self.assertEqual(parse_amount_cents("50"), 5000)
        self.assertEqual(parse_amount_cents("12.5"), 1250)
        self.assertEqual(parse_amount_cents("0.01"), 1)
        self.assertEqual(parse_amount_cents("$1,200.00"), 120000)

    def test_cents_avoid_float_error(self):
        # 0.1 + 0.2 != 0.3 in float; in cents it is exact.
        self.assertNotEqual(0.1 + 0.2, 0.3)
        self.assertEqual(parse_amount_cents("0.10") + parse_amount_cents("0.20"),
                         parse_amount_cents("0.30"))

    def test_invalid_amounts_are_rejected_with_reason(self):
        for bad in ["twenty", "", "  ", "-5.00", "0", "0.00", "1.234", "12,34",
                    "NaN", "inf", "1e3", "100000000000"]:
            with self.subTest(bad=bad):
                with self.assertRaises(AmountError):
                    parse_amount_cents(bad)

    def test_format_and_percent(self):
        self.assertEqual(format_cents(123456), "$1,234.56")
        self.assertEqual(format_cents(-500), "-$5.00")
        self.assertEqual(percent(18000, 25000), Decimal("72.0"))
        self.assertIsNone(percent(100, 0))


class TestIngest(unittest.TestCase):
    def test_malformed_amount_is_reported_not_hidden(self):
        """Packet Q7: a row containing 'twenty' is rejected and reported;
        valid rows are still imported."""
        r = parse_csv_text(HEADER
                           + "A1,2026-09-01,CITY MARKET,20.00,purchase\n"
                           + "A2,2026-09-02,CORNER CAFE,twenty,purchase\n"
                           + "A3,2026-09-03,CORNER CAFE,30.00,purchase\n")
        self.assertEqual([t.txn_id for t in r.valid], ["A1", "A3"])
        self.assertEqual(len(r.errors), 1)
        e = r.errors[0]
        self.assertEqual((e.row_number, e.txn_id, e.field, e.value), (3, "A2", "amount", "twenty"))
        self.assertIn("twenty", e.message())
        self.assertEqual(sum(t.amount_cents for t in r.valid), 5000)

    def test_bad_date_type_blank_and_duplicate_rows(self):
        r = parse_csv_text(HEADER
                           + "B1,2026-02-30,X,1.00,purchase\n"
                           + "B2,2026-09-01,X,1.00,gift\n"
                           + ",2026-09-01,X,1.00,purchase\n"
                           + "B3,2026-09-01,,1.00,purchase\n"
                           + "B4,2026-09-01,X,1.00,purchase\n"
                           + "B4,2026-09-01,X,1.00,purchase\n")
        fields = [e.field for e in r.errors]
        self.assertEqual(fields, ["date", "type", "transaction_id", "description", "transaction_id"])
        self.assertIn("duplicate", r.errors[-1].reason)
        self.assertEqual([t.txn_id for t in r.valid], ["B4"])

    def test_missing_required_column(self):
        r = parse_csv_text("transaction_id,date,amount\nX,2026-09-01,1\n")
        self.assertIn("description", r.header_error)
        self.assertEqual(r.valid, [])

    def test_type_defaults_to_purchase_and_bom_ok(self):
        r = parse_csv_text("﻿transaction_id,date,description,amount\nC1,2026-09-01,CAFE,5\n")
        self.assertEqual(r.valid[0].txn_type, "purchase")

    def test_empty_file_gives_header_error(self):
        self.assertIsNotNone(parse_csv_text("").header_error)


if __name__ == "__main__":
    unittest.main()
