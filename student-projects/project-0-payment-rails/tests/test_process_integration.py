"""Exercise the actual six spawn processes, routing, reset, and failure behavior."""
import unittest
from simulator.supervisor import CommandError, Supervisor


class ProcessIntegration(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.supervisor = Supervisor(seed=19, start_scheduler=False)

    @classmethod
    def tearDownClass(cls):
        cls.supervisor.close()

    def setUp(self):
        self.supervisor.command({"action": "reset", "seed": 19})

    def drain(self):
        for _ in range(300):
            if not self.supervisor.state()["pending_count"]:
                return
            self.supervisor.command({"action": "step"})
        self.fail("Messages failed to drain.")

    def purchase(self, **extras):
        result = self.supervisor.command(dict(action="purchase", **extras))
        self.drain()
        return result["payment_id"]

    def test_real_process_ids_and_complete_reverse_authorization(self):
        state = self.supervisor.state()
        self.assertEqual(len({agent["pid"] for agent in state["agents"]}), 6)
        self.assertTrue(all(agent["alive"] for agent in state["agents"]))
        pid = self.purchase(preset="approved")
        state = self.supervisor.state()
        self.assertEqual([event["recipient"] for event in state["events"]],
                         ["payer", "merchant", "gateway", "acquirer", "network", "issuer",
                          "network", "acquirer", "gateway", "merchant", "payer"])
        self.assertEqual(state["payments"][0]["status"], "AUTHORIZED")
        self.assertEqual(state["balances"]["posted_cents"], 50000)
        self.assertEqual(state["balances"]["available_cents"], 45000)
        self.assertEqual(state["account_balances"]["demo-active"]["available_cents"], 45000)
        self.assertEqual(state["account_balances"]["demo-low"]["available_cents"], 1000)
        self.assertTrue(all(event["payment_id"] == pid for event in state["events"]))
        self.assertTrue(all(event["operation_id"] == pid + ":authorize" for event in state["events"]))
        self.assertEqual(len(self.supervisor.state(after=9)["events"]), 2)

    def test_full_lifecycle_retries_and_batch_reconciliation(self):
        pid = self.purchase()
        self.supervisor.command({"action": "replay", "payment_id": pid})
        self.drain()
        self.assertEqual(self.supervisor.state()["balances"]["held_cents"], 5000)
        self.supervisor.command({"action": "capture", "payment_id": pid})
        self.drain()
        self.assertEqual(self.supervisor.state()["balances"]["posted_cents"], 50000)
        bid = self.supervisor.command({"action": "clear"})["batch_id"]
        self.drain()
        state = self.supervisor.state()
        self.assertEqual(state["balances"]["posted_cents"], 45000)
        self.assertEqual(state["balances"]["held_cents"], 0)
        self.assertEqual(state["balances"]["pending_settlement_cents"], 5000)
        for _ in range(2):
            self.supervisor.command({"action": "settle", "batch_id": bid})
            self.drain()
        self.supervisor.command({"action": "clear", "batch_id": bid})
        self.drain()
        state = self.supervisor.state()
        self.assertEqual(state["payments"][0]["status"], "SETTLED")
        self.assertEqual(state["balances"]["merchant_cents"], 4875)
        self.assertEqual(state["balances"]["pending_settlement_cents"], 0)
        self.assertEqual(state["balances"]["posted_cents"], 45000)

    def test_all_decline_presets_and_serial_competing_authorizations(self):
        for preset in ("insufficient", "inactive", "invalid"):
            self.purchase(preset=preset)
        self.supervisor.command({"action": "purchase", "amount_cents": 30000})
        self.supervisor.command({"action": "purchase", "amount_cents": 30000})
        self.drain()
        state = self.supervisor.state()
        self.assertEqual([item["status"] for item in state["payments"]], ["DECLINED", "DECLINED", "DECLINED", "AUTHORIZED", "DECLINED"])
        self.assertEqual(state["balances"]["held_cents"], 30000)

    def test_multiple_sales_reconcile_as_one_batch_with_per_sale_rounding(self):
        first = self.purchase(amount_cents=250)
        second = self.purchase(amount_cents=500)
        for pid in (first, second):
            self.supervisor.command({"action": "capture", "payment_id": pid})
        self.drain()
        bid = self.supervisor.command({"action": "clear"})["batch_id"]
        self.drain()
        state = self.supervisor.state()
        self.assertEqual(state["balances"]["posted_cents"], 49250)
        self.assertEqual(state["balances"]["pending_settlement_cents"], 750)
        self.assertEqual(len(state["batches"][0]["items"]), 2)
        self.supervisor.command({"action": "settle", "batch_id": bid})
        self.drain()
        state = self.supervisor.state()
        self.assertEqual(state["balances"]["merchant_cents"], 712)
        self.assertEqual(state["balances"]["network_fee_cents"], 1)
        self.assertEqual(state["balances"]["processing_fee_cents"], 22)
        self.assertEqual(state["balances"]["interchange_cents"], 15)
        self.assertTrue(all(item["status"] == "SETTLED" for item in state["payments"]))

    def test_settlement_projection_keeps_funds_visible_until_acquirer_credit(self):
        pid = self.purchase()
        self.supervisor.command({"action": "capture", "payment_id": pid})
        self.drain()
        bid = self.supervisor.command({"action": "clear"})["batch_id"]
        self.drain()
        self.supervisor.command({"action": "settle", "batch_id": bid})
        self.assertEqual(self.supervisor.state()["payments"][0]["status"], "SETTLING")
        for _ in range(10):
            event = self.supervisor.command({"action": "step"})["event"]
            if event["type"] == "SETTLE_REQUEST" and event["recipient"] == "issuer":
                break
        else:
            self.fail("Settlement never reached the issuer.")
        state = self.supervisor.state()
        self.assertEqual(self.supervisor.snapshots["issuer"]["pending"], {})
        self.assertEqual(state["balances"]["posted_cents"], 45000)
        self.assertEqual(state["balances"]["pending_settlement_cents"], 5000)
        self.assertEqual(state["balances"]["settlement_in_transit_cents"], 5000)
        self.assertEqual(state["balances"]["merchant_cents"], 0)
        self.assertEqual(state["payments"][0]["status"], "SETTLING")
        self.supervisor.command({"action": "step"})  # Issuer result reaches network.
        self.assertEqual(self.supervisor.state()["balances"]["pending_settlement_cents"], 5000)
        self.supervisor.command({"action": "step"})  # Network result reaches acquirer; allocation occurs.
        state = self.supervisor.state()
        self.assertEqual(state["balances"]["pending_settlement_cents"], 0)
        self.assertEqual(state["balances"]["settlement_in_transit_cents"], 0)
        self.assertEqual(state["balances"]["merchant_cents"], 4875)
        self.assertEqual(state["payments"][0]["status"], "SETTLING")
        self.drain()
        self.assertEqual(self.supervisor.state()["payments"][0]["status"], "SETTLED")

    def test_reset_restarts_workers_and_isolates_old_session(self):
        self.purchase()
        before = self.supervisor.state()
        old_processes = list(self.supervisor.processes.values())
        self.supervisor.command({"action": "reset", "seed": 23})
        after = self.supervisor.state()
        self.assertNotEqual(before["session_id"], after["session_id"])
        self.assertFalse(any(process.is_alive() for process in old_processes))
        self.assertEqual(after["events"], [])
        self.assertEqual(after["payments"], [])
        self.assertEqual(after["balances"]["posted_cents"], 50000)
        self.assertEqual(after["balances"]["held_cents"], 0)

    def test_failed_participant_pauses_without_inventing_an_outcome(self):
        self.supervisor.command({"action": "purchase"})
        process = self.supervisor.processes["issuer"]
        process.terminate()
        process.join(timeout=2)
        state = self.supervisor.state()
        self.assertTrue(state["paused"])
        self.assertIn("Issuer", state["fault"])
        self.assertEqual(state["events"], [])
        with self.assertRaises(CommandError):
            self.supervisor.command({"action": "step"})
        self.supervisor.command({"action": "reset"})
        self.assertIsNone(self.supervisor.state()["fault"])

    def test_automatic_purchases_are_seeded_and_speed_controls_validate(self):
        def sequence():
            for _ in range(400):
                self.supervisor._auto_tick()
                if len(self.supervisor.payments) == 5:
                    break
            return [(item["amount_cents"], item["account_id"], item["network"])
                    for item in self.supervisor.payments.values()]
        first = sequence()
        self.supervisor.command({"action": "reset", "seed": 19})
        self.assertEqual(sequence(), first)
        self.supervisor.command({"action": "speed", "speed_ms": 150})
        self.supervisor.command({"action": "mode", "mode": "automatic"})
        self.supervisor.command({"action": "pause", "paused": True})
        self.assertEqual(self.supervisor.state()["speed_ms"], 150)
        self.assertTrue(self.supervisor.state()["paused"])
        for speed in (True, 0, 149, 1501, "fast"):
            with self.assertRaises(CommandError):
                self.supervisor.command({"action": "speed", "speed_ms": speed})

    def test_invalid_api_commands_and_conflicting_identifier(self):
        for command in ({"action": "settle"}, {"action": "clear"}, {"action": "capture", "payment_id": "missing"},
                        {"action": "purchase", "amount_cents": True}, {"action": "purchase", "currency": "EUR"}):
            with self.assertRaises(CommandError):
                self.supervisor.command(command)
        pid = self.purchase()
        with self.assertRaises(CommandError):
            self.supervisor.command({"action": "purchase", "payment_id": pid, "amount_cents": 5100})
        for field in ("action", "preset", "payment_id", "batch_id", "account_id", "network", "operation_id", "currency"):
            for value in ([], {}, 1, True):
                with self.assertRaises(CommandError):
                    self.supervisor.command(dict({"action": "purchase"}, **{field: value}))


if __name__ == "__main__":
    unittest.main()
