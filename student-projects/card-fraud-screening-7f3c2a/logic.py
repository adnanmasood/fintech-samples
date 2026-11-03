"""Business logic for the Card Payment Fraud Screening System (fictional demo)."""
import math

LOW_RISK_LIMIT = 0.20   # score < 0.20 -> APPROVE
HIGH_RISK_LIMIT = 0.80  # score >= 0.80 -> DECLINE


def _result(status, reason, transaction):
    return {
        "status": status,
        "reason": reason,
        "transaction_id": transaction.get("transaction_id"),
    }


def _is_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _invalid_field_reason(transaction):
    """Return a reason for the first invalid non-score field, else None."""
    tid = transaction.get("transaction_id")
    if not isinstance(tid, str) or not tid.strip():
        return "INVALID_TRANSACTION_ID"
    amount = transaction.get("amount_cents")
    if not isinstance(amount, int) or isinstance(amount, bool) or amount <= 0:
        return "INVALID_AMOUNT"
    if not isinstance(transaction.get("card_blocked"), bool):
        return "INVALID_CARD_BLOCKED"
    if not isinstance(transaction.get("model_timeout"), bool):
        return "INVALID_MODEL_TIMEOUT"
    return None


def _valid_score(score):
    return _is_number(score) and math.isfinite(score) and 0 <= score <= 1


def screen_transaction(transaction):
    """Screen one transaction and return status, reason and transaction_id."""
    if not isinstance(transaction, dict):
        return {"status": "INVALID_INPUT", "reason": "INVALID_TRANSACTION",
                "transaction_id": None}

    # Rule 1: validate ID, amount and flags before any decision rule.
    bad = _invalid_field_reason(transaction)
    if bad:
        return _result("INVALID_INPUT", bad, transaction)

    # Rule 2: a blocked card overrides score and timeout.
    if transaction["card_blocked"]:
        return _result("DECLINE", "CARD_BLOCKED", transaction)

    # Rule 3: no usable model result -> challenge.
    score = transaction.get("risk_score")
    if transaction["model_timeout"] or score is None:
        return _result("CHALLENGE", "MODEL_UNAVAILABLE", transaction)

    # Rule 4: an available score must be a finite number in [0, 1].
    if not _valid_score(score):
        return _result("INVALID_INPUT", "INVALID_SCORE", transaction)

    # Rules 5-7: score bands.
    if score < LOW_RISK_LIMIT:
        return _result("APPROVE", "LOW_RISK", transaction)
    if score < HIGH_RISK_LIMIT:
        return _result("CHALLENGE", "VERIFICATION_REQUIRED", transaction)
    return _result("DECLINE", "HIGH_RISK", transaction)
