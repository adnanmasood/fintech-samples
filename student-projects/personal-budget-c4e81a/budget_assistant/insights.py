"""Plain-language insights grounded in the verified Report.

The default explanation is a template filled only from Report fields.
An optional generator (e.g. an LLM) may be plugged in, but its text is
checked against the Report; if it fails, times out, or makes an unsupported
claim, the verified template is returned instead. The numeric report is
never blocked by narrative failure.
"""
from __future__ import annotations

import re
from typing import Callable, Optional

from .money import format_cents
from .report import Report

_DOLLAR_RE = re.compile(r"\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{2}))?")
_PCT_RE = re.compile(r"(\d+(?:\.\d+)?)\s?%")
_MONTHS = ("january february march april may june july august september "
           "october november december").split()
_ALLOWANCE_PHRASES = ("safely spend", "can spend", "safe to spend", "afford",
                      "you can still spend")
_COMPARISON_PHRASES = ("from last month", "than last month", "up from", "down from",
                       "increase from", "decrease from", "compared to", "compared with")


def template_explanation(r: Report) -> str:
    if r.transaction_count == 0:
        return "No valid transactions were imported, so no spending was calculated."
    period = f"{r.period_start.isoformat()} to {r.period_end.isoformat()}"
    parts = [f"For {period}, recorded net spending was "
             f"{format_cents(r.net_spending_cents)}."]
    if r.coverage == "PARTIAL":
        note = f" ({r.coverage_note})" if r.coverage_note else ""
        parts.append(f"This total is partial{note}, so actual spending may be higher.")
    if r.category_totals:
        top_cat, top_amt = next(iter(r.category_totals.items()))
        parts.append(f"The largest category was {top_cat} at {format_cents(top_amt)}.")
    for b in r.budget_lines:
        if b.status == "OVER":
            parts.append(f"{b.category} is over budget by "
                         f"{format_cents(-b.remaining_cents)} ({b.pct_used}% used).")
        elif b.status == "NEAR_LIMIT":
            parts.append(f"{b.category} has {format_cents(b.remaining_cents)} left "
                         f"({b.pct_used}% used).")
    if r.uncategorized_ids:
        parts.append(f"{len(r.uncategorized_ids)} transaction(s) need a category "
                     "before category totals are final.")
    if r.row_errors:
        parts.append(f"{len(r.row_errors)} row(s) were rejected and are not in "
                     "these totals; see the error list.")
    if r.previous_period_comparison == "NOT_COMPUTED":
        parts.append("No comparison with a previous period was computed.")
    return " ".join(parts)


def check_narrative(text: str, r: Report) -> list[str]:
    """Return a list of problems: claims in `text` the Report does not support."""
    issues: list[str] = []
    low = text.lower()
    allowed = r.all_amounts_cents()
    for m in _DOLLAR_RE.finditer(text):
        cents = int(m.group(1).replace(",", "")) * 100 + int(m.group(2) or 0)
        if cents not in allowed:
            issues.append(f"amount {m.group(0)} is not a verified report value")
    allowed_pcts = {str(b.pct_used) for b in r.budget_lines if b.pct_used is not None}
    allowed_pcts |= {p.rstrip("0").rstrip(".") for p in allowed_pcts}
    for m in _PCT_RE.finditer(text):
        if m.group(1) not in allowed_pcts:
            issues.append(f"percentage {m.group(0)} is not a verified report value")
    if any(p in low for p in _ALLOWANCE_PHRASES):
        issues.append("gives a spending allowance the report did not calculate")
    if r.previous_period_comparison == "NOT_COMPUTED":
        if any(p in low for p in _COMPARISON_PHRASES) or any(
            f"from {mo}" in low or f"than {mo}" in low for mo in _MONTHS
        ):
            issues.append("compares with a previous period, but no comparison was computed")
    if r.coverage == "PARTIAL" and "partial" not in low:
        issues.append("does not disclose that coverage is PARTIAL")
    if r.coverage == "PARTIAL" and re.search(r"\b(for|in|during) (" + "|".join(_MONTHS) + r")\b", low):
        issues.append("describes a whole month, but only part of it is covered")
    return issues


def explain(r: Report, generator: Optional[Callable[[Report], str]] = None):
    """Return (text, source, issues). source is 'generated' or 'verified_template'."""
    if generator is None:
        return template_explanation(r), "verified_template", []
    try:
        text = generator(r)
    except Exception as exc:  # timeout, outage, etc.
        return template_explanation(r), "verified_template", [f"generator failed: {exc}"]
    issues = check_narrative(text, r)
    if issues:
        return template_explanation(r), "verified_template", issues
    return text, "generated", []
