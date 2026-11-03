"""Exact money handling.

All amounts are stored as integer cents. Binary floating point is never used
for money: 0.1 + 0.2 != 0.3 in float, but 10 + 20 == 30 in cents.
"""
from __future__ import annotations

import re
from decimal import ROUND_HALF_UP, Decimal

# Optional leading "$", digits with optional thousands commas, up to 2 decimals.
_AMOUNT_RE = re.compile(r"^\$?(\d{1,3}(,\d{3})+|\d+)(\.\d{1,2})?$")

MAX_CENTS = 100_000_000_00  # $100M per row: guards against absurd/overflow input


class AmountError(ValueError):
    """Raised when a raw amount cannot be accepted. The message is user-facing."""


def parse_amount_cents(raw: str) -> int:
    """Parse a positive money string such as "12.50" or "$1,200" into cents.

    Rejects text ("twenty"), blanks, negatives, zero, more than two decimal
    places, NaN/Infinity and absurdly large values. Direction (spend vs refund)
    comes from the transaction type, never from the sign.
    """
    if raw is None:
        raise AmountError("amount is missing")
    text = str(raw).strip()
    if text == "":
        raise AmountError("amount is blank")
    if text.startswith("-"):
        raise AmountError(
            f"amount '{text}' is negative; use a positive amount and set type=refund"
        )
    if not _AMOUNT_RE.match(text):
        raise AmountError(
            f"amount '{text}' is not a valid number with at most 2 decimal places"
        )
    value = Decimal(text.lstrip("$").replace(",", ""))
    cents = int((value * 100).to_integral_value())
    if cents == 0:
        raise AmountError("amount must be greater than zero")
    if cents > MAX_CENTS:
        raise AmountError(f"amount '{text}' exceeds the allowed maximum")
    return cents


def format_cents(cents: int) -> str:
    """Format cents as dollars: 123456 -> "$1,234.56", -500 -> "-$5.00"."""
    sign = "-" if cents < 0 else ""
    c = abs(cents)
    return f"{sign}${c // 100:,}.{c % 100:02d}"


def percent(part_cents: int, whole_cents: int) -> Decimal | None:
    """part/whole as a percentage rounded to one decimal, or None if whole is 0."""
    if whole_cents == 0:
        return None
    return (Decimal(part_cents) * 100 / Decimal(whole_cents)).quantize(
        Decimal("0.1"), rounding=ROUND_HALF_UP
    )
