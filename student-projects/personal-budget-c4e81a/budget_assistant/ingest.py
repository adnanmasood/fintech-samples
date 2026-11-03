"""CSV ingestion and validation.

Every row either becomes a valid Transaction or a RowError with a reason.
Nothing is silently dropped, zeroed, or guessed.
"""
from __future__ import annotations

import csv
import io
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

from .models import TRANSACTION_TYPES, RowError, Transaction
from .money import AmountError, parse_amount_cents

REQUIRED_COLUMNS = ("transaction_id", "date", "description", "amount")
OPTIONAL_COLUMNS = ("type", "account")


@dataclass
class ImportResult:
    valid: list[Transaction] = field(default_factory=list)
    errors: list[RowError] = field(default_factory=list)
    header_error: str | None = None

    @property
    def rows_read(self) -> int:
        return len(self.valid) + len(self.errors)


def parse_csv_text(text: str) -> ImportResult:
    result = ImportResult()
    text = text.lstrip("﻿")  # tolerate a UTF-8 BOM from spreadsheet exports
    reader = csv.DictReader(io.StringIO(text))
    headers = [h.strip().lower() for h in (reader.fieldnames or [])]
    missing = [c for c in REQUIRED_COLUMNS if c not in headers]
    if missing:
        result.header_error = (
            "CSV is missing required column(s): " + ", ".join(missing)
            + ". Required: " + ", ".join(REQUIRED_COLUMNS)
        )
        return result
    reader.fieldnames = headers

    seen_ids: dict[str, int] = {}
    for line_no, raw in enumerate(reader, start=2):
        row = {k: (v or "").strip() for k, v in raw.items() if k is not None}
        if not any(row.values()):
            continue  # fully blank line
        txn, err = _parse_row(row, line_no, seen_ids)
        if err:
            result.errors.append(err)
        else:
            seen_ids[txn.txn_id] = line_no
            result.valid.append(txn)
    return result


def parse_csv_file(path: str | Path) -> ImportResult:
    return parse_csv_text(Path(path).read_text(encoding="utf-8"))


def _parse_row(row: dict, line_no: int, seen_ids: dict[str, int]):
    tid = row.get("transaction_id", "")

    def err(fld: str, reason: str):
        return None, RowError(line_no, tid, fld, row.get(fld, ""), reason)

    if not tid:
        return err("transaction_id", "transaction_id is blank")
    if tid in seen_ids:
        return err(
            "transaction_id",
            f"duplicate transaction_id; first seen on row {seen_ids[tid]}",
        )
    try:
        d = date.fromisoformat(row.get("date", ""))
    except ValueError:
        return err("date", f"date '{row.get('date', '')}' is not YYYY-MM-DD")
    desc = row.get("description", "")
    if not desc:
        return err("description", "description is blank")
    try:
        cents = parse_amount_cents(row.get("amount", ""))
    except AmountError as e:
        return err("amount", str(e))
    ttype = (row.get("type") or "purchase").lower()
    if ttype not in TRANSACTION_TYPES:
        return err(
            "type", f"type '{ttype}' must be one of: {', '.join(TRANSACTION_TYPES)}"
        )
    return (
        Transaction(tid, d, desc, cents, ttype, row.get("account", "")),
        None,
    )
