"""Onboarding consistency checker (business rules only).

Meridian Bank Labs | Bank Account Onboarding System | Fictional classroom prototype.

This module has no Streamlit imports. It compares a fictional signup record with a
mock extracted-ID record and returns a status plus ordered reason codes.

It does NOT verify identity, perform KYC, check sanctions or age eligibility,
authenticate documents, or create/approve a customer account.
"""

import re
from datetime import date, datetime

READY = "READY_FOR_VERIFICATION"
REVIEW = "REVIEW"

# Validation reason codes, in the order they are collected (guide page 4).
MISSING_SIGNUP_NAME = "MISSING_SIGNUP_NAME"
MISSING_SIGNUP_DOB = "MISSING_SIGNUP_DOB"
INVALID_SIGNUP_DOB = "INVALID_SIGNUP_DOB"
MISSING_ID_NAME = "MISSING_ID_NAME"
MISSING_ID_DOB = "MISSING_ID_DOB"
INVALID_ID_DOB = "INVALID_ID_DOB"

# Comparison reason codes (only produced when both records are valid).
NAME_MISMATCH = "NAME_MISMATCH"
DOB_MISMATCH = "DOB_MISMATCH"

VALIDATION_CODES = {
    MISSING_SIGNUP_NAME,
    MISSING_SIGNUP_DOB,
    INVALID_SIGNUP_DOB,
    MISSING_ID_NAME,
    MISSING_ID_DOB,
    INVALID_ID_DOB,
}
MISMATCH_CODES = {NAME_MISMATCH, DOB_MISMATCH}

# Plain-language explanations shown to the onboarding reviewer.
REASON_TEXT = {
    MISSING_SIGNUP_NAME: "The signup record has no full name (blank, whitespace only, or not text).",
    MISSING_SIGNUP_DOB: "The signup record has no date of birth.",
    INVALID_SIGNUP_DOB: "The signup date of birth is not a real date in YYYY-MM-DD format.",
    MISSING_ID_NAME: "The mock ID extraction returned no full name.",
    MISSING_ID_DOB: "The mock ID extraction returned no date of birth.",
    INVALID_ID_DOB: "The mock ID date of birth is not a real date in YYYY-MM-DD format.",
    NAME_MISMATCH: "The names differ after allowed normalization (case and spacing only).",
    DOB_MISMATCH: "The dates of birth on the two records are different days.",
}

_DATE_PATTERN = re.compile(r"\d{4}-\d{2}-\d{2}")


def normalized_name(value: str) -> str:
    """Trim, collapse internal whitespace and case-fold.

    This is the ONLY normalization allowed. Punctuation and accents are kept and
    no spelling corrections are guessed (so "Dana Li" never becomes "Dana Lee").
    """
    return " ".join(value.split()).casefold()


def checked_dob(value: str) -> date:
    """Parse a strictly formatted, real calendar date.

    Raises ValueError for anything that is not zero-padded YYYY-MM-DD
    (e.g. "1999-4-12") or is not a real day (e.g. "1999-02-30").
    """
    if not _DATE_PATTERN.fullmatch(value):
        raise ValueError("Use YYYY-MM-DD")
    return datetime.strptime(value, "%Y-%m-%d").date()


def _has_text(value) -> bool:
    return isinstance(value, str) and value.strip() != ""


def _check_name(record: dict, missing_code: str, reasons: list):
    value = record.get("full_name")
    if not _has_text(value):
        reasons.append(missing_code)
        return None
    return normalized_name(value)


def _check_dob(record: dict, missing_code: str, invalid_code: str, reasons: list):
    value = record.get("date_of_birth")
    if not _has_text(value):
        reasons.append(missing_code)
        return None
    try:
        # Surrounding whitespace is not trimmed: " 1999-04-12" fails the strict format.
        return checked_dob(value)
    except ValueError:
        reasons.append(invalid_code)
        return None


def check_onboarding(signup: dict, extracted_id: dict) -> dict:
    """Return {"status": ..., "reasons": [...]} for a signup vs. mock-ID record pair.

    Rules, applied in order (guide page 4):
      1. Validate signup name, signup DOB, ID name, ID DOB (in that order).
      2. If any validation reason exists -> REVIEW with those reasons.
      3. Otherwise compare normalized names, then dates; include both mismatches.
      4. No mismatches -> READY_FOR_VERIFICATION with reasons == [].

    The function is stateless and never modifies either input record.
    """
    signup = signup if isinstance(signup, dict) else {}
    extracted_id = extracted_id if isinstance(extracted_id, dict) else {}

    reasons: list = []
    signup_name = _check_name(signup, MISSING_SIGNUP_NAME, reasons)
    signup_dob = _check_dob(signup, MISSING_SIGNUP_DOB, INVALID_SIGNUP_DOB, reasons)
    id_name = _check_name(extracted_id, MISSING_ID_NAME, reasons)
    id_dob = _check_dob(extracted_id, MISSING_ID_DOB, INVALID_ID_DOB, reasons)

    if reasons:
        return {"status": REVIEW, "reasons": reasons}

    if signup_name != id_name:
        reasons.append(NAME_MISMATCH)
    if signup_dob != id_dob:
        reasons.append(DOB_MISMATCH)

    if reasons:
        return {"status": REVIEW, "reasons": reasons}
    return {"status": READY, "reasons": []}


def outcome_category(result: dict) -> str:
    """Group a result into one of three reviewer-facing scenarios for display.

    PASS          -> READY_FOR_VERIFICATION (consistent data; NOT an approved identity)
    FAIL          -> REVIEW because a required field is missing or invalid
    UNDER_REVIEW  -> REVIEW because valid records disagree (name and/or DOB mismatch)

    This does not change the status or reasons; it only selects which screen to show.
    """
    if result["status"] == READY:
        return "PASS"
    if any(code in VALIDATION_CODES for code in result["reasons"]):
        return "FAIL"
    return "UNDER_REVIEW"


def comparison_checklist(signup: dict, extracted_id: dict, result: dict) -> list:
    """Build a small completeness/match table for the screen.

    Each row: (check, signup_value, id_value, outcome) where outcome is
    "Pass", "Fail" or "Not compared".
    """
    reasons = set(result["reasons"])
    validation_failed = bool(reasons & VALIDATION_CODES)

    def shown(record, key):
        value = record.get(key)
        return value if isinstance(value, str) and value != "" else "(blank)"

    def outcome(codes):
        return "Fail" if reasons & codes else "Pass"

    rows = [
        ("Signup name present", shown(signup, "full_name"), "", outcome({MISSING_SIGNUP_NAME})),
        ("Signup DOB valid (YYYY-MM-DD)", shown(signup, "date_of_birth"), "",
         outcome({MISSING_SIGNUP_DOB, INVALID_SIGNUP_DOB})),
        ("ID name present", "", shown(extracted_id, "full_name"), outcome({MISSING_ID_NAME})),
        ("ID DOB valid (YYYY-MM-DD)", "", shown(extracted_id, "date_of_birth"),
         outcome({MISSING_ID_DOB, INVALID_ID_DOB})),
    ]
    compare = "Not compared" if validation_failed else None
    rows.append(("Names match (case/spacing only)", shown(signup, "full_name"),
                 shown(extracted_id, "full_name"), compare or outcome({NAME_MISMATCH})))
    rows.append(("Dates of birth match", shown(signup, "date_of_birth"),
                 shown(extracted_id, "date_of_birth"), compare or outcome({DOB_MISMATCH})))
    return rows
