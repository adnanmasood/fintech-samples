"""Application service: the one place that wires ingestion, storage,
categorization, reporting and insights together. The CLI and web UI both
call these functions, so they always show the same numbers."""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from .categorize import decide_all
from .ingest import ImportResult, parse_csv_text
from .insights import explain
from .money import parse_amount_cents
from .report import Report, build_report
from .store import JsonStore, StoreImportOutcome


@dataclass
class ImportSummary:
    parsed: ImportResult
    stored: StoreImportOutcome | None


def load_budgets(path: str | Path) -> dict[str, int]:
    """budgets.json maps category -> dollar string, e.g. {"Groceries": "250.00"}."""
    raw = json.loads(Path(path).read_text(encoding="utf-8"))
    return {cat: parse_amount_cents(str(v)) for cat, v in raw.items()}


def import_csv(store: JsonStore, user_id: str, text: str, source: str = "") -> ImportSummary:
    parsed = parse_csv_text(text)
    if parsed.header_error:
        return ImportSummary(parsed, None)
    stored = store.import_transactions(
        user_id, parsed.valid, source=source,
        rejected=[e.message() for e in parsed.errors],
    )
    return ImportSummary(parsed, stored)


def user_report(store: JsonStore, user_id: str, budgets: dict[str, int],
                coverage: str = "COMPLETE", coverage_note: str = "",
                generator=None) -> tuple[Report, dict, tuple[str, str, list[str]]]:
    txns = store.transactions(user_id)
    decisions = decide_all(txns, overrides=store.overrides(user_id),
                           user_rules=store.merchant_rules(user_id))
    log = store.import_log(user_id)
    row_errors_msgs = log[-1]["rejected_rows"] if log else []
    report = build_report(txns, decisions, budgets, coverage=coverage,
                          coverage_note=coverage_note)
    report.row_errors = row_errors_msgs  # messages from the latest import
    return report, decisions, explain(report, generator)
