"""Transparent merchant-to-category rule map.

Rules are (keyword, category) pairs checked in order against the upper-cased
description. The first keyword contained in the description wins. A rule map
is fully explainable: for any transaction you can point to the exact rule.
"""
from __future__ import annotations

UNCATEGORIZED = "Uncategorized"

DEFAULT_RULES: list[tuple[str, str]] = [
    # Groceries
    ("CITY MARKET", "Groceries"),
    ("FRESHWAY", "Groceries"),
    ("GREENLEAF GROCERY", "Groceries"),
    # Dining
    ("CORNER CAFE", "Dining"),
    ("BAYSIDE BISTRO", "Dining"),
    ("PIZZA PALACE", "Dining"),
    # Transport / travel
    ("RAILCO", "Travel"),
    ("METRO TRANSIT", "Transport"),
    ("QUICKFUEL", "Transport"),
    # Housing & utilities
    ("RENT", "Housing"),
    ("SUNCOAST POWER", "Utilities"),
    ("AQUAWORKS", "Utilities"),
    # Entertainment / subscriptions
    ("STREAMFLIX", "Subscriptions"),
    ("CINEPLEX", "Entertainment"),
    # Health
    ("WELLCARE PHARMACY", "Health"),
]


def match_rule(description: str, rules: list[tuple[str, str]] | None = None):
    """Return (category, keyword) for the first matching rule, else None."""
    text = description.upper()
    for keyword, category in rules if rules is not None else DEFAULT_RULES:
        if keyword.upper() in text:
            return category, keyword
    return None


def merchant_key(description: str) -> str:
    """Normalized merchant key used by user-specific merchant rules."""
    return " ".join(description.upper().split())
