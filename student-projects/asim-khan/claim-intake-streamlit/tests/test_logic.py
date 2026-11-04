"""Tests for logic.check_claim -- the 8 cases from build guide page 8,
plus a boundary case for the input-type contract and the required
modification (next_steps_for).
"""

import copy
import sys
import unittest
from pathlib import Path

# So `python -m unittest discover -s tests` works without a package install.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from logic import check_claim, next_steps_for, NEEDS_INFORMATION, READY_FOR_REVIEW


class CheckClaimTests(unittest.TestCase):
    def test_all_fields_complete_one_document(self):
        claim = {
            "policy_id": "P001",
            "incident_date": "2026-09-20",
            "description": "Minor water damage in kitchen",
            "documents": ["photo_01.jpg"],
        }
        self.assertEqual(
            check_claim(claim), {"status": READY_FOR_REVIEW, "missing": []}
        )

    def test_incident_date_absent(self):
        claim = {
            "policy_id": "P001",
            "description": "Water damage",
            "documents": ["photo_01.jpg"],
        }
        self.assertEqual(
            check_claim(claim),
            {"status": NEEDS_INFORMATION, "missing": ["incident_date"]},
        )

    def test_blank_description_and_empty_documents(self):
        claim = {
            "policy_id": "P001",
            "incident_date": "2026-09-20",
            "description": " ",
            "documents": [],
        }
        self.assertEqual(
            check_claim(claim),
            {"status": NEEDS_INFORMATION, "missing": ["description", "documents"]},
        )

    def test_policy_id_blank_and_date_missing(self):
        claim = {
            "policy_id": "   ",
            "description": "Minor water damage in kitchen",
            "documents": ["photo_01.jpg"],
        }
        self.assertEqual(
            check_claim(claim),
            {
                "status": NEEDS_INFORMATION,
                "missing": ["policy_id", "incident_date"],
            },
        )

    def test_documents_all_blank(self):
        claim = {
            "policy_id": "P001",
            "incident_date": "2026-09-20",
            "description": "Minor water damage in kitchen",
            "documents": ["", " "],
        }
        self.assertEqual(
            check_claim(claim),
            {"status": NEEDS_INFORMATION, "missing": ["documents"]},
        )

    def test_documents_one_blank_one_nonblank_passes(self):
        claim = {
            "policy_id": "P001",
            "incident_date": "2026-09-20",
            "description": "Minor water damage in kitchen",
            "documents": [" ", "photo_01.jpg"],
        }
        self.assertEqual(
            check_claim(claim), {"status": READY_FOR_REVIEW, "missing": []}
        )

    def test_documents_as_string_not_accepted(self):
        claim = {
            "policy_id": "P001",
            "incident_date": "2026-09-20",
            "description": "Minor water damage in kitchen",
            "documents": "photo_01.jpg",
        }
        self.assertEqual(
            check_claim(claim),
            {"status": NEEDS_INFORMATION, "missing": ["documents"]},
        )

    def test_input_unchanged_and_output_has_only_status_and_missing(self):
        claim = {
            "policy_id": "P001",
            "incident_date": "2026-09-20",
            "description": "Minor water damage in kitchen",
            "documents": ["photo_01.jpg"],
        }
        original = copy.deepcopy(claim)
        result = check_claim(claim)
        self.assertEqual(claim, original)
        self.assertEqual(set(result.keys()), {"status", "missing"})
        self.assertNotIn("payout", result)
        self.assertNotIn("approved", result)

    def test_non_dictionary_input(self):
        result = check_claim("not a claim")
        self.assertEqual(result["status"], NEEDS_INFORMATION)
        self.assertEqual(
            sorted(result["missing"]),
            sorted(["policy_id", "incident_date", "description", "documents"]),
        )


class NextStepsModificationTests(unittest.TestCase):
    """The required modification: a human-readable next step when
    description is missing, with missing=[description] and
    NEEDS_INFORMATION unchanged."""

    def test_missing_description_next_step(self):
        claim = {
            "policy_id": "P001",
            "incident_date": "2026-09-20",
            "description": "   ",
            "documents": ["photo_01.jpg"],
        }
        result = check_claim(claim)
        self.assertEqual(result["status"], NEEDS_INFORMATION)
        self.assertEqual(result["missing"], ["description"])
        self.assertEqual(
            next_steps_for(result["missing"]),
            ["Describe what happened and where."],
        )

    def test_next_steps_empty_when_nothing_missing(self):
        self.assertEqual(next_steps_for([]), [])


if __name__ == "__main__":
    unittest.main()
