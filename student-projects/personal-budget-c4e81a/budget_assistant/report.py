"""Deterministic budget report.

This module owns every number shown to the user. It uses integer cents only
and checks its own invariant: category totals must add up to net spending.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal

from .models import CategoryDecision, RowError, Transaction
from .money import percent
from .rules import UNCATEGORIZED

NEAR_LIMIT_PCT = Decimal("80")


@dataclass
class BudgetLine:
    category: str
    budget_cents: int
    spent_cents: int
    remaining_cents: int  # negative when over budget
    pct_used: Decimal | None
    status: str  # OK | NEAR_LIMIT | OVER


@dataclass
class Report:
    period_start: date | None
    period_end: date | None
    coverage: str  # COMPLETE | PARTIAL
    coverage_note: str
    category_totals: dict[str, int]
    net_spending_cents: int
    income_cents: int
    transfers_cents: int
    card_payments_cents: int
    budget_lines: list[BudgetLine]
    uncategorized_ids: list[str]
    row_errors: list[RowError] = field(default_factory=list)
    previous_period_comparison: str = "NOT_COMPUTED"
    transaction_count: int = 0

    @property
    def income_minus_spending_cents(self) -> int:
        return self.income_cents - self.net_spending_cents

    def all_amounts_cents(self) -> set[int]:
        """Every money value this report verified (used by the narrative check)."""
        vals = set(self.category_totals.values())
        vals |= {self.net_spending_cents, self.income_cents, self.transfers_cents,
                 self.card_payments_cents, self.income_minus_spending_cents}
        for b in self.budget_lines:
            vals |= {b.budget_cents, b.spent_cents, abs(b.remaining_cents)}
        return vals


def build_report(
    transactions: list[Transaction],
    decisions: dict[str, CategoryDecision],
    budgets: dict[str, int] | None = None,
    row_errors: list[RowError] | None = None,
    coverage: str = "COMPLETE",
    coverage_note: str = "",
    period_start: date | None = None,
    period_end: date | None = None,
) -> Report:
    budgets = budgets or {}
    if coverage not in ("COMPLETE", "PARTIAL"):
        raise ValueError("coverage must be COMPLETE or PARTIAL")

    totals: dict[str, int] = {}
    income = transfers = card_payments = 0
    uncategorized: list[str] = []
    for t in transactions:
        if t.txn_type == "income":
            income += t.amount_cents
        elif t.txn_type == "transfer":
            transfers += t.amount_cents
        elif t.txn_type == "card_payment":
            card_payments += t.amount_cents
        else:
            cat = decisions[t.txn_id].category
            totals[cat] = totals.get(cat, 0) + t.spending_effect_cents
            if cat == UNCATEGORIZED:
                uncategorized.append(t.txn_id)

    net = sum(t.spending_effect_cents for t in transactions)
    # Invariant: re-categorizing moves money between categories, never creates it.
    assert sum(totals.values()) == net, "category totals do not reconcile"

    lines = []
    for cat, budget in sorted(budgets.items()):
        spent = totals.get(cat, 0)
        pct = percent(spent, budget)
        if spent > budget:
            status = "OVER"
        elif pct is not None and pct >= NEAR_LIMIT_PCT:
            status = "NEAR_LIMIT"
        else:
            status = "OK"
        lines.append(BudgetLine(cat, budget, spent, budget - spent, pct, status))

    dates = [t.date for t in transactions]
    return Report(
        period_start=period_start or (min(dates) if dates else None),
        period_end=period_end or (max(dates) if dates else None),
        coverage=coverage,
        coverage_note=coverage_note,
        category_totals=dict(sorted(totals.items(), key=lambda kv: -kv[1])),
        net_spending_cents=net,
        income_cents=income,
        transfers_cents=transfers,
        card_payments_cents=card_payments,
        budget_lines=lines,
        uncategorized_ids=uncategorized,
        row_errors=list(row_errors or []),
        transaction_count=len(transactions),
    )
