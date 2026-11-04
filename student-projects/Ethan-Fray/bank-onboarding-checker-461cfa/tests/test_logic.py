"""Repeatable checks for logic.py (guide page 8 table plus boundaries).

Run from the project folder:
    .venv/bin/python -m unittest discover -s tests -v
"""

import copy
import json
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from logic import (  # noqa: E402
    READY,
    REVIEW,
    check_onboarding,
    checked_dob,
    comparison_checklist,
    normalized_name,
    outcome_category,
)


def rec(name, dob):
    """Fresh fictional record for each independent case."""
    return {"full_name": name, "date_of_birth": dob}


class HelperTests(unittest.TestCase):
    def test_case_and_spaces_only(self):
        self.assertEqual(normalized_name(" DANA              Lee "), "dana lee")

    def test_tabs_and_newlines_collapse(self):
        self.assertEqual(normalized_name("\tDana\n  Lee\t"), "dana lee")

    def test_punctuation_and_accents_preserved(self):
        self.assertEqual(normalized_name("José O'Neil-Ríos"), "josé o'neil-ríos")
        self.assertNotEqual(normalized_name("Jose"), normalized_name("José"))

    def test_impossible_date(self):
        with self.assertRaises(ValueError):
            checked_dob("1999-02-30")

    def test_unpadded_date_rejected(self):
        with self.assertRaises(ValueError):
            checked_dob("1999-4-12")

    def test_valid_leap_day(self):
        self.assertEqual(checked_dob("2000-02-29").isoformat(), "2000-02-29")


class PageEightCases(unittest.TestCase):
    def test_matching_records_ready(self):
        result = check_onboarding(rec("Dana Lee", "1999-04-12"), rec("Dana Lee", "1999-04-12"))
        self.assertEqual(result, {"status": READY, "reasons": []})

    def test_case_spacing_ready_and_original_unchanged(self):
        signup = rec(" dana lee ", "1999-04-12")
        extracted = rec("DANA LEE", "1999-04-12")
        before = (copy.deepcopy(signup), copy.deepcopy(extracted))
        result = check_onboarding(signup, extracted)
        self.assertEqual(result, {"status": READY, "reasons": []})
        self.assertEqual((signup, extracted), before)

    def test_name_mismatch_not_fuzzy_matched(self):
        result = check_onboarding(rec("Dana Lee", "1999-04-12"), rec("Dana Li", "1999-04-12"))
        self.assertEqual(result, {"status": REVIEW, "reasons": ["NAME_MISMATCH"]})

    def test_id_dob_omitted(self):
        result = check_onboarding(rec("Dana Lee", "1999-04-12"), {"full_name": "Dana Lee"})
        self.assertEqual(result, {"status": REVIEW, "reasons": ["MISSING_ID_DOB"]})

    def test_dob_mismatch(self):
        result = check_onboarding(rec("Dana Lee", "1999-04-12"), rec("Dana Lee", "1999-04-21"))
        self.assertEqual(result, {"status": REVIEW, "reasons": ["DOB_MISMATCH"]})

    def test_impossible_signup_date(self):
        result = check_onboarding(rec("Dana Lee", "1999-02-30"), rec("Dana Lee", "1999-04-12"))
        self.assertEqual(result, {"status": REVIEW, "reasons": ["INVALID_SIGNUP_DOB"]})

    def test_unpadded_id_date(self):
        result = check_onboarding(rec("Dana Lee", "1999-04-12"), rec("Dana Lee", "1999-4-12"))
        self.assertEqual(result, {"status": REVIEW, "reasons": ["INVALID_ID_DOB"]})

    def test_whitespace_signup_name_and_blank_id_dob_ordered(self):
        result = check_onboarding(rec("   ", "1999-04-12"), rec("Dana Lee", ""))
        self.assertEqual(
            result, {"status": REVIEW, "reasons": ["MISSING_SIGNUP_NAME", "MISSING_ID_DOB"]}
        )

    def test_name_and_dob_both_conflict(self):
        result = check_onboarding(rec("Dana Lee", "1999-04-12"), rec("Dana Li", "1999-04-21"))
        self.assertEqual(result, {"status": REVIEW, "reasons": ["NAME_MISMATCH", "DOB_MISMATCH"]})


class BoundaryCases(unittest.TestCase):
    def test_all_four_fields_missing_in_order(self):
        result = check_onboarding({}, {})
        self.assertEqual(
            result["reasons"],
            ["MISSING_SIGNUP_NAME", "MISSING_SIGNUP_DOB", "MISSING_ID_NAME", "MISSING_ID_DOB"],
        )

    def test_nonstring_name_is_missing(self):
        result = check_onboarding(rec(12345, "1999-04-12"), rec(None, "1999-04-12"))
        self.assertEqual(result["reasons"], ["MISSING_SIGNUP_NAME", "MISSING_ID_NAME"])

    def test_validation_blocks_comparison(self):
        # Names differ, but an invalid date means no mismatch codes are reported yet.
        result = check_onboarding(rec("Dana Lee", "1999-13-01"), rec("Dana Li", "1999-04-12"))
        self.assertEqual(result, {"status": REVIEW, "reasons": ["INVALID_SIGNUP_DOB"]})

    def test_date_with_surrounding_space_is_invalid(self):
        result = check_onboarding(rec("Dana Lee", " 1999-04-12"), rec("Dana Lee", "1999-04-12"))
        self.assertEqual(result["reasons"], ["INVALID_SIGNUP_DOB"])

    def test_non_leap_feb_29_invalid(self):
        result = check_onboarding(rec("Dana Lee", "1999-02-29"), rec("Dana Lee", "1999-02-29"))
        self.assertEqual(result["reasons"], ["INVALID_SIGNUP_DOB", "INVALID_ID_DOB"])


class ModificationTests(unittest.TestCase):
    """Small modification: example button fills mock ID name with ' DANA LEE '."""

    def test_padded_uppercase_id_name_still_ready(self):
        signup = rec("Dana Lee", "1999-04-12")
        extracted = rec(" DANA LEE ", "1999-04-12")
        result = check_onboarding(signup, extracted)
        self.assertEqual(result, {"status": READY, "reasons": []})
        self.assertEqual(extracted["full_name"], " DANA LEE ")  # original preserved


class ScenarioCategoryTests(unittest.TestCase):
    def test_categories(self):
        self.assertEqual(outcome_category({"status": READY, "reasons": []}), "PASS")
        self.assertEqual(outcome_category({"status": REVIEW, "reasons": ["MISSING_ID_DOB"]}), "FAIL")
        self.assertEqual(
            outcome_category({"status": REVIEW, "reasons": ["NAME_MISMATCH"]}), "UNDER_REVIEW"
        )

    def test_checklist_marks_comparison_not_run_when_invalid(self):
        signup, extracted = rec("Dana Lee", "1999-04-12"), rec("Dana Lee", "")
        rows = comparison_checklist(signup, extracted, check_onboarding(signup, extracted))
        self.assertEqual(rows[3][3], "Fail")
        self.assertEqual(rows[4][3], "Not compared")

    def test_example_file_expectations(self):
        with open(os.path.join(ROOT, "data", "examples.json"), encoding="utf-8") as fh:
            scenarios = json.load(fh)["scenarios"]
        for key, case in scenarios.items():
            with self.subTest(scenario=key):
                self.assertEqual(
                    check_onboarding(case["signup"], case["extracted_id"]), case["expected"]
                )


if __name__ == "__main__":
    unittest.main()
