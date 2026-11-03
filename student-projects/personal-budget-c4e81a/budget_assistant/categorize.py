"""Effective-category resolution.

Precedence (highest first):
  1. Saved transaction override   - the user corrected THIS transaction
  2. User-specific merchant rule  - the user said "always put X in Y" (opt-in)
  3. Built-in rule map            - transparent keyword rules
  4. Optional classifier          - only if confidence >= threshold
  5. Uncategorized                - kept visible, never hidden or guessed

The classifier only *proposes a label*. It never computes money.
Non-spending types (income, transfer, card_payment) are excluded up front.
"""
from __future__ import annotations

from typing import Callable, Optional

from .models import CategoryDecision, Transaction
from .rules import UNCATEGORIZED, match_rule, merchant_key

# A classifier takes a description and returns (category, confidence 0..1).
Classifier = Callable[[str], tuple[str, float]]
DEFAULT_CONFIDENCE_THRESHOLD = 0.80


def decide_category(
    txn: Transaction,
    overrides: dict[str, str] | None = None,
    user_rules: dict[str, str] | None = None,
    rules: list[tuple[str, str]] | None = None,
    classifier: Optional[Classifier] = None,
    threshold: float = DEFAULT_CONFIDENCE_THRESHOLD,
) -> CategoryDecision:
    if not txn.is_spending:
        return CategoryDecision(f"Excluded ({txn.txn_type})", "excluded",
                                "not counted as spending")
    overrides = overrides or {}
    user_rules = user_rules or {}

    if txn.txn_id in overrides:
        return CategoryDecision(overrides[txn.txn_id], "override",
                                "user corrected this transaction")
    key = merchant_key(txn.description)
    if key in user_rules:
        return CategoryDecision(user_rules[key], "user_rule",
                                f"user rule for merchant '{key}'")
    hit = match_rule(txn.description, rules)
    if hit:
        return CategoryDecision(hit[0], "rule_map", f"keyword '{hit[1]}'")
    if classifier is not None:
        try:
            label, conf = classifier(txn.description)
        except Exception as exc:  # classifier outage must not break the report
            return CategoryDecision(UNCATEGORIZED, "uncategorized",
                                    f"classifier unavailable: {exc}")
        if conf >= threshold:
            return CategoryDecision(label, "classifier",
                                    f"predicted with confidence {conf:.2f}")
        return CategoryDecision(UNCATEGORIZED, "uncategorized",
                                f"low confidence ({conf:.2f}) for '{label}'; needs review")
    return CategoryDecision(UNCATEGORIZED, "uncategorized", "no rule matched; needs review")


def decide_all(txns, **kwargs) -> dict[str, CategoryDecision]:
    return {t.txn_id: decide_category(t, **kwargs) for t in txns}
