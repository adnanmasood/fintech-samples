import copy
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from logic import moved_balances, new_state, total_funds, transfer


def req(request_id="R001", sender="A", recipient="B", amount=5000, currency="USD"):
    return {"request_id": request_id, "sender": sender, "recipient": recipient,
            "amount_cents": amount, "currency": currency}


class TransferTests(unittest.TestCase):
    def test_money_is_conserved(self):
        before = {"A": 10000, "B": 2000}
        after = moved_balances(before, "A", "B", 5000)
        self.assertEqual(after, {"A": 5000, "B": 7000})
        self.assertEqual(sum(after.values()), sum(before.values()))
        self.assertEqual(before["A"], 10000)  # input copy untouched

    def test_reasons_are_readable_text(self):
        reasons = {
            "COMPLETED": transfer(new_state(), req())[1],
            "INSUFFICIENT_FUNDS": transfer(new_state(), req(amount=10001))[1],
            "INVALID_AMOUNT": transfer(new_state(), req(amount=0))[1],
            "INVALID_REQUEST": transfer(new_state(), req(sender="A", recipient="A"))[1],
        }
        for status, res in reasons.items():
            with self.subTest(status=status):
                self.assertEqual(res["status"], status)
                self.assertTrue(res["reason"])
                self.assertEqual(res["request_id"], "R001")

    def test_completed(self):
        state = new_state()
        before = copy.deepcopy(state)
        new, res = transfer(state, req())
        self.assertEqual(res["status"], "COMPLETED")
        self.assertEqual(new["balances"], {"A": 5000, "B": 7000})
        self.assertEqual(sum(new["balances"].values()), 12000)
        self.assertEqual(state, before)  # input not mutated

    def test_duplicate(self):
        s1, first = transfer(new_state(), req())
        s2, res = transfer(s1, req())
        self.assertEqual(res["status"], "DUPLICATE_REQUEST")
        self.assertEqual(s2, s1)
        self.assertEqual(s2["balances"], {"A": 5000, "B": 7000})
        self.assertEqual(res["original_receipt"], first["receipt"])

    def test_conflict(self):
        s1, _ = transfer(new_state(), req())
        s2, res = transfer(s1, req(amount=6000))
        self.assertEqual(res["status"], "REQUEST_CONFLICT")
        self.assertEqual(s2["balances"], {"A": 5000, "B": 7000})
        self.assertEqual(s2, s1)

    def test_insufficient_funds(self):
        state = new_state()
        new, res = transfer(state, req(amount=10001))
        self.assertEqual(res["status"], "INSUFFICIENT_FUNDS")
        self.assertEqual(new["balances"], {"A": 10000, "B": 2000})
        self.assertNotIn("R001", new["requests"])

    def test_invalid_amounts(self):
        for bad in (0, -1, 1.5, True):
            with self.subTest(amount=bad):
                new, res = transfer(new_state(), req(amount=bad))
                self.assertEqual(res["status"], "INVALID_AMOUNT")
                self.assertEqual(new["requests"], {})
                self.assertEqual(new["balances"], {"A": 10000, "B": 2000})

    def test_invalid_amount_string(self):
        _, res = transfer(new_state(), req(amount="100"))
        self.assertEqual(res["status"], "INVALID_AMOUNT")

    def test_invalid_requests(self):
        cases = {
            "same wallet": req(sender="A", recipient="A"),
            "blank id": req(request_id="   "),
            "unknown wallet": req(recipient="C"),
            "non-USD": req(currency="EUR"),
        }
        for name, r in cases.items():
            with self.subTest(case=name):
                new, res = transfer(new_state(), r)
                self.assertEqual(res["status"], "INVALID_REQUEST")
                self.assertEqual(new, new_state())

    def test_rejected_does_not_reserve_id(self):
        s1, _ = transfer(new_state(), req(amount=10001))
        s2, res = transfer(s1, req(amount=5000))
        self.assertEqual(res["status"], "COMPLETED")

    def test_id_trimmed(self):
        s1, _ = transfer(new_state(), req(request_id="  R001  "))
        _, res = transfer(s1, req(request_id="R001"))
        self.assertEqual(res["status"], "DUPLICATE_REQUEST")

    def test_two_ids_conserve_funds(self):
        s1, _ = transfer(new_state(), req("R001", "A", "B", 5000))
        s2, res = transfer(s1, req("R002", "B", "A", 1500))
        self.assertEqual(res["status"], "COMPLETED")
        self.assertEqual(set(s2["requests"]), {"R001", "R002"})
        self.assertEqual(s2["balances"], {"A": 6500, "B": 5500})
        self.assertEqual(sum(s2["balances"].values()), 12000)

    def test_total_funds_invariant_across_sequence(self):
        state = new_state()
        self.assertEqual(total_funds(state), 12000)
        sequence = [
            req("R001", "A", "B", 5000),    # COMPLETED
            req("R001", "A", "B", 5000),    # DUPLICATE_REQUEST
            req("R001", "A", "B", 6000),    # REQUEST_CONFLICT
            req("R002", "A", "B", 99999),   # INSUFFICIENT_FUNDS
            req("R003", "A", "B", 0),       # INVALID_AMOUNT
            req("", "A", "B", 100),         # INVALID_REQUEST
            req("R004", "B", "A", 7000),    # COMPLETED
            req("R005", "B", "A", 1),       # INSUFFICIENT_FUNDS (B is 0)
        ]
        for r in sequence:
            state, _ = transfer(state, r)
            self.assertEqual(total_funds(state), 12000)


if __name__ == "__main__":
    unittest.main()
