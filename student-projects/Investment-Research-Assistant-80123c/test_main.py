import tempfile
import unittest
from pathlib import Path
import main


class SearchTests(unittest.TestCase):
    def test_normal_input(self):
        self.assertEqual(
            main.search("lithium"),
            "supply_chain.txt:2: Lead times for lithium cells fell to 14 days.",
        )

    def test_multi_keyword_and_stemming(self):
        self.assertEqual(
            main.search("interest rate hedge"),
            "risk_outlook.txt:4: Interest rate hedges cover 60% of floating debt.",
        )

    def test_stopwords_ignored(self):
        self.assertEqual(main.search("what is the warehouse utilization"),
                         "supply_chain.txt:3: The Rotterdam warehouse reached 92% utilization.")

    def test_doubled_consonant_stem(self):
        self.assertEqual(
            main.search("flag"),
            "supply_chain.txt:4: Two suppliers were flagged for late deliveries.",
        )

    def test_supply_matches_supplier(self):
        self.assertEqual(main._stem("supply"), main._stem("suppliers"))
        self.assertEqual(
            main.search("supply"),
            "supply_chain.txt:4: Two suppliers were flagged for late deliveries.",
        )

    def test_title_used_only_as_fallback(self):
        self.assertEqual(main.search("supply chain review"),
                         "supply_chain.txt:1: Supply Chain Review (fictional)")

    def test_narrow_rule_avoids_false_matches(self):
        for a, b in [("policy", "police"), ("treasury", "treasure"),
                     ("part", "party"), ("read", "ready"), ("city", "cite")]:
            self.assertNotEqual(main._stem(a), main._stem(b), (a, b))

    def test_hyphenated_queries_and_text(self):
        self.assertTrue(main.search("interest-rate hedge").startswith("risk_outlook.txt:4:"))
        self.assertTrue(main.search("floating-rate debt").startswith("risk_outlook.txt:4:"))
        self.assertTrue(main.search("14-day").startswith("supply_chain.txt:2:"))
        with tempfile.TemporaryDirectory() as d:
            Path(d, "a.txt").write_text("Title\nGrowth was year-over-year.\n")
            self.assertTrue(main.search("year over year", d).startswith("a.txt:2:"))

    def test_bad_bytes_do_not_hide_rest_of_file(self):
        with tempfile.TemporaryDirectory() as d:
            Path(d, "b.txt").write_bytes(b"Title\n\xff\xfe bad bytes\nmore lithium here\n")
            self.assertEqual(main.search("lithium", d), "b.txt:3: more lithium here")

    def test_whole_word_only(self):
        self.assertEqual(main.search("ate"), "NOT_FOUND")  # inside "rate"

    def test_partial_support_is_not_found(self):
        self.assertEqual(main.search("lithium bitcoin"), "NOT_FOUND")

    def test_failure_returns_not_found(self):
        self.assertEqual(main.search("bitcoin"), "NOT_FOUND")
        self.assertEqual(main.search(""), "NOT_FOUND")
        self.assertEqual(main.search("the of and"), "NOT_FOUND")
        self.assertEqual(main.search(None), "NOT_FOUND")

    def test_retrieve_structured(self):
        self.assertEqual(main.retrieve("rotterdam")["line"], 3)


if __name__ == "__main__":
    unittest.main()
