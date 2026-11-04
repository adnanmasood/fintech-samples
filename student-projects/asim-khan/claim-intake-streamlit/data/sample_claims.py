"""Fictional example claims for manual testing -- not used by the app or tests.

Paste these into the Streamlit form, or import and call logic.check_claim(claim)
directly from a Python shell, to reproduce the normal/failure demonstrations.
"""

NORMAL_CLAIM = {
    "policy_id": "P001",
    "incident_date": "2026-09-20",
    "description": "Minor water damage in kitchen",
    "documents": ["photo_01.jpg"],
}

MISSING_INCIDENT_DATE = {
    "policy_id": "P001",
    "incident_date": "",
    "description": "Minor water damage in kitchen",
    "documents": ["photo_01.jpg"],
}

MULTIPLE_MISSING = {
    "policy_id": "P001",
    "incident_date": "",
    "description": "   ",
    "documents": [],
}
