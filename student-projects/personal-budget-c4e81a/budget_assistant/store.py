"""Per-user JSON persistence.

Every read and write takes a user_id and touches only that user's namespace.
This is the server-side access control: customer A's request can never read
or correct customer B's transactions, no matter what a prompt or form says.

Saved data survives restarts: transactions, transaction overrides,
user merchant rules, and an import log (evidence trail).
"""
from __future__ import annotations

import json
import os
import tempfile
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from .models import Transaction
from .rules import merchant_key


class AccessError(KeyError):
    """Raised when a user references a transaction that is not theirs."""


@dataclass
class StoreImportOutcome:
    added: list[str] = field(default_factory=list)
    already_imported: list[str] = field(default_factory=list)  # same ID, same data
    conflicts: list[str] = field(default_factory=list)  # same ID, different data


class JsonStore:
    def __init__(self, path: str | Path):
        self.path = Path(path)
        self._data = {"users": {}}
        if self.path.exists():
            self._data = json.loads(self.path.read_text(encoding="utf-8"))

    # ---------- internals ----------
    def _user(self, user_id: str) -> dict:
        if not user_id:
            raise ValueError("user_id is required")
        return self._data["users"].setdefault(
            user_id,
            {"transactions": {}, "overrides": {}, "merchant_rules": {},
             "corrections_log": [], "imports": []},
        )

    def _save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=self.path.parent, suffix=".tmp")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(self._data, f, indent=2, sort_keys=True)
        os.replace(tmp, self.path)  # atomic: no half-written store on crash

    @staticmethod
    def _now() -> str:
        return datetime.now(timezone.utc).isoformat(timespec="seconds")

    # ---------- transactions ----------
    def import_transactions(self, user_id: str, txns: list[Transaction],
                            source: str = "",
                            rejected: list[str] | None = None) -> StoreImportOutcome:
        u = self._user(user_id)
        out = StoreImportOutcome()
        for t in txns:
            existing = u["transactions"].get(t.txn_id)
            if existing is None:
                u["transactions"][t.txn_id] = t.to_dict()
                out.added.append(t.txn_id)
            elif existing == t.to_dict():
                out.already_imported.append(t.txn_id)
            else:
                out.conflicts.append(t.txn_id)
        u["imports"].append({
            "at": self._now(), "source": source, "added": len(out.added),
            "already_imported": len(out.already_imported),
            "conflicts": out.conflicts, "rejected_rows": list(rejected or []),
        })
        self._save()
        return out

    def transactions(self, user_id: str) -> list[Transaction]:
        u = self._user(user_id)
        return sorted((Transaction.from_dict(d) for d in u["transactions"].values()),
                      key=lambda t: (t.date, t.txn_id))

    # ---------- corrections ----------
    def set_override(self, user_id: str, txn_id: str, category: str,
                     previous: str = "") -> None:
        u = self._user(user_id)
        if txn_id not in u["transactions"]:
            # Same error whether the ID belongs to someone else or doesn't
            # exist, so the response leaks nothing about other customers.
            raise AccessError(f"transaction {txn_id} not found for this user")
        category = category.strip()
        if not category:
            raise ValueError("category is blank")
        u["overrides"][txn_id] = category
        u["corrections_log"].append({"at": self._now(), "txn_id": txn_id,
                                     "from": previous, "to": category,
                                     "kind": "transaction_override"})
        self._save()

    def overrides(self, user_id: str) -> dict[str, str]:
        return dict(self._user(user_id)["overrides"])

    def set_merchant_rule(self, user_id: str, description: str, category: str) -> None:
        """Explicit, opt-in rule: future transactions from this merchant for
        THIS user go to `category`. Never applied to other users."""
        u = self._user(user_id)
        key = merchant_key(description)
        u["merchant_rules"][key] = category.strip()
        u["corrections_log"].append({"at": self._now(), "merchant": key,
                                     "to": category.strip(), "kind": "merchant_rule"})
        self._save()

    def merchant_rules(self, user_id: str) -> dict[str, str]:
        return dict(self._user(user_id)["merchant_rules"])

    def corrections_log(self, user_id: str) -> list[dict]:
        return list(self._user(user_id)["corrections_log"])

    def import_log(self, user_id: str) -> list[dict]:
        return list(self._user(user_id)["imports"])

    def clear_user(self, user_id: str) -> None:
        """Delete one user's demo data (used by the demo 'reset' button)."""
        self._data["users"].pop(user_id, None)
        self._save()
