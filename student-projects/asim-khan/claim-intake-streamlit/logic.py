"""Claim completeness checker -- Assignment 7 Streamlit-compliant minimum.

A small pure function with no Streamlit imports, so unittest and the
Streamlit screen call the exact same implementation (build guide page 6).
Mirrors the data contract on build guide page 4:

    policy_id, incident_date, description -- required nonblank text.
    documents -- a list with at least one nonblank string label.

This is a completeness checker only. It never approves, denies, decides
coverage, or pays a claim -- it decides whether a case has enough
information to hand to a human adjuster for review.
"""

READY_FOR_REVIEW = "READY_FOR_REVIEW"
NEEDS_INFORMATION = "NEEDS_INFORMATION"

REQUIRED_TEXT_FIELDS = ("policy_id", "incident_date", "description")

# The required modification (build guide page 6): a human-readable next step
# for a missing description. Kept as a lookup for every field so the screen
# can show one next-step message per missing item, not description alone.
NEXT_STEPS = {
    "policy_id": "Provide the policy ID.",
    "incident_date": "Provide the date the incident happened.",
    "description": "Describe what happened and where.",
    "documents": "Add at least one document name.",
}


def check_claim(claim):
    """Check a claim for completeness.

    Returns {"status": READY_FOR_REVIEW | NEEDS_INFORMATION, "missing": [...]}.
    missing lists field names in a fixed order: policy_id, incident_date,
    description, documents. Reads fields without modifying the input claim.
    A non-dictionary input returns NEEDS_INFORMATION with all four items
    missing, per build guide page 4.
    """
    claim = claim if isinstance(claim, dict) else {}
    missing = []

    for field in REQUIRED_TEXT_FIELDS:
        value = claim.get(field)
        if not isinstance(value, str) or not value.strip():
            missing.append(field)

    docs = claim.get("documents")
    if not isinstance(docs, list) or not any(
        isinstance(name, str) and name.strip() for name in docs
    ):
        missing.append("documents")

    status = NEEDS_INFORMATION if missing else READY_FOR_REVIEW
    return {"status": status, "missing": missing}


def next_steps_for(missing):
    """Human-readable next-step messages for each missing field, in order.

    Pure lookup, no inference: only fields already in `missing` get a
    message, and the message never implies a coverage or payment decision.
    """
    return [NEXT_STEPS[field] for field in missing if field in NEXT_STEPS]
