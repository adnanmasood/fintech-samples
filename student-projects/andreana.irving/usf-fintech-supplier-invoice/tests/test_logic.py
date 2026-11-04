"""Repeatable checks for logic.py, covering the page 8 test-case table.

Run with:
    .venv/bin/python -m unittest discover -s tests -v
"""
import unittest

from logic import (
    STATUS_DUPLICATE,
    STATUS_INVALID,
    STATUS_PENDING,
    check_invoice,
    invoice_key,
)


class InvoiceKeyTests(unittest.TestCase):
    # Guide's starter test (page 8): two suppliers using the same invoice
    # number must not collide on the same key.
    def test_two_suppliers_are_distinct(self):
        a = {"supplier_id": "S01", "invoice_number": "INV-101"}
        b = {"supplier_id": "S02", "invoice_number": "INV-101"}
        self.assertNotEqual(invoice_key(a), invoice_key(b))


class CheckInvoiceTests(unittest.TestCase):
    def setUp(self):
        self.base_invoice = {
            "supplier_id": "S01",
            "invoice_number": "INV-101",
            "amount_cents": 100000,
            "filename": "invoice_101.json",
        }

    # Case: S01 / INV-101 / 100000 cents -> PENDING_APPROVAL; record count=1.
    def test_new_pair_is_pending_approval_with_count_one(self):
        records, result = check_invoice({}, self.base_invoice)
        self.assertEqual(result["status"], STATUS_PENDING)
        self.assertEqual(result["key"], ("S01", "INV-101"))
        self.assertEqual(len(records), 1)
        self.assertEqual(records[("S01", "INV-101")]["amount_cents"], 100000)

    # Case: submit the same invoice again -> DUPLICATE; count=1, original
    # record unchanged.
    def test_resubmitting_same_invoice_is_duplicate(self):
        records, _ = check_invoice({}, self.base_invoice)
        records2, result = check_invoice(records, self.base_invoice)
        self.assertEqual(result["status"], STATUS_DUPLICATE)
        self.assertEqual(len(records2), 1)
        self.assertEqual(records2[("S01", "INV-101")]["amount_cents"], 100000)

    # Case: same pair, new filename and 110000 cents -> DUPLICATE; stored
    # amount remains 100000.
    def test_duplicate_with_changed_filename_and_amount_keeps_original(self):
        records, _ = check_invoice({}, self.base_invoice)
        resubmitted = {
            "supplier_id": "S01",
            "invoice_number": "INV-101",
            "amount_cents": 110000,
            "filename": "resubmitted.json",
        }
        records2, result = check_invoice(records, resubmitted)
        self.assertEqual(result["status"], STATUS_DUPLICATE)
        self.assertEqual(len(records2), 1)
        self.assertEqual(records2[("S01", "INV-101")]["amount_cents"], 100000)
        self.assertEqual(result["existing_invoice"]["amount_cents"], 100000)
        self.assertEqual(result["existing_invoice"]["filename"], "invoice_101.json")

    # Case: S02 / INV-101 / 100000 cents -> PENDING_APPROVAL; different
    # supplier key accepted.
    def test_same_invoice_number_different_supplier_is_new_pair(self):
        records, _ = check_invoice({}, self.base_invoice)
        other_supplier = dict(self.base_invoice, supplier_id="S02")
        records2, result = check_invoice(records, other_supplier)
        self.assertEqual(result["status"], STATUS_PENDING)
        self.assertEqual(len(records2), 2)
        self.assertIn(("S01", "INV-101"), records2)
        self.assertIn(("S02", "INV-101"), records2)

    # Case: supplier or invoice blank/whitespace -> INVALID_INPUT; count
    # unchanged.
    def test_blank_supplier_id_is_invalid(self):
        invoice = dict(self.base_invoice, supplier_id="   ")
        records, result = check_invoice({}, invoice)
        self.assertEqual(result["status"], STATUS_INVALID)
        self.assertEqual(records, {})

    def test_blank_invoice_number_is_invalid(self):
        invoice = dict(self.base_invoice, invoice_number="")
        records, result = check_invoice({}, invoice)
        self.assertEqual(result["status"], STATUS_INVALID)
        self.assertEqual(records, {})

    def test_missing_supplier_id_key_is_invalid(self):
        invoice = {
            "invoice_number": "INV-101",
            "amount_cents": 100000,
        }
        records, result = check_invoice({}, invoice)
        self.assertEqual(result["status"], STATUS_INVALID)
        self.assertEqual(records, {})

    # Case: amount 0, -1, 1.5 or True -> INVALID_INPUT; no new record.
    def test_zero_amount_is_invalid(self):
        invoice = dict(self.base_invoice, amount_cents=0)
        records, result = check_invoice({}, invoice)
        self.assertEqual(result["status"], STATUS_INVALID)
        self.assertEqual(records, {})

    def test_negative_amount_is_invalid(self):
        invoice = dict(self.base_invoice, amount_cents=-1)
        records, result = check_invoice({}, invoice)
        self.assertEqual(result["status"], STATUS_INVALID)
        self.assertEqual(records, {})

    def test_fractional_amount_is_invalid(self):
        invoice = dict(self.base_invoice, amount_cents=1.5)
        records, result = check_invoice({}, invoice)
        self.assertEqual(result["status"], STATUS_INVALID)
        self.assertEqual(records, {})

    def test_boolean_amount_is_invalid(self):
        invoice = dict(self.base_invoice, amount_cents=True)
        records, result = check_invoice({}, invoice)
        self.assertEqual(result["status"], STATUS_INVALID)
        self.assertEqual(records, {})

    # Case: " S01 " / " INV-101 " after normal case -> DUPLICATE after
    # trimming.
    def test_padded_identifiers_match_trimmed_original(self):
        records, _ = check_invoice({}, self.base_invoice)
        padded = dict(
            self.base_invoice,
            supplier_id=" S01 ",
            invoice_number=" INV-101 ",
        )
        records2, result = check_invoice(records, padded)
        self.assertEqual(result["status"], STATUS_DUPLICATE)
        self.assertEqual(len(records2), 1)

    # Case preserved (not folded): "s01" must NOT match stored "S01".
    def test_key_is_case_sensitive(self):
        records, _ = check_invoice({}, self.base_invoice)
        lowercase = dict(self.base_invoice, supplier_id="s01")
        records2, result = check_invoice(records, lowercase)
        self.assertEqual(result["status"], STATUS_PENDING)
        self.assertEqual(len(records2), 2)

    # Invalid input must have no state effect: the same records object is
    # returned, not a copy and not a mutated original.
    def test_invalid_input_does_not_mutate_or_replace_records(self):
        records = {}
        invoice = dict(self.base_invoice, supplier_id="")
        new_records, result = check_invoice(records, invoice)
        self.assertIs(new_records, records)
        self.assertEqual(new_records, {})

    # A duplicate must also leave the original records object alone
    # (no in-place mutation), matching "return existing record unchanged".
    def test_duplicate_does_not_mutate_records(self):
        records, _ = check_invoice({}, self.base_invoice)
        before = dict(records)
        check_invoice(records, self.base_invoice)
        self.assertEqual(records, before)


class DuplicateExplanationTests(unittest.TestCase):
    # duplicate_explanation does not exist in logic.py yet. Imported inside
    # each test method (not at module scope) so these tests fail on their
    # own without breaking collection/execution of the tests above.

    def setUp(self):
        self.existing_invoice = {
            "supplier_id": "S01",
            "invoice_number": "INV-101",
            "amount_cents": 100000,
            "filename": "invoice_101.json",
            "status": STATUS_PENDING,
        }
        self.submitted_invoice = {
            "supplier_id": "S01",
            "invoice_number": "INV-101",
            "amount_cents": 110000,
            "filename": "resubmitted.json",
        }

    def test_duplicate_explanation_returns_original_submitted_and_difference(self):
        from logic import duplicate_explanation

        explanation = duplicate_explanation(self.existing_invoice, self.submitted_invoice)

        self.assertEqual(explanation["original_amount_cents"], 100000)
        self.assertEqual(explanation["submitted_amount_cents"], 110000)
        self.assertEqual(explanation["difference_cents"], 10000)

    def test_check_invoice_still_returns_duplicate_for_changed_amount(self):
        records, _ = check_invoice({}, {
            "supplier_id": "S01",
            "invoice_number": "INV-101",
            "amount_cents": 100000,
            "filename": "invoice_101.json",
        })

        new_records, result = check_invoice(records, self.submitted_invoice)

        self.assertEqual(result["status"], STATUS_DUPLICATE)
        self.assertEqual(len(new_records), 1)
        self.assertEqual(new_records[("S01", "INV-101")]["amount_cents"], 100000)


if __name__ == "__main__":
    unittest.main()
