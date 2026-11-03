"""Core records. The original amount and description are never mutated."""
from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import date

# How each transaction type affects *spending* (not the bank balance).
#   purchase      -> counts as spending when made
#   refund        -> reduces spending in the purchase's category
#   income        -> not spending
#   transfer      -> moving money between the person's own accounts; not spending
#   card_payment  -> paying a card bill; the purchase was already counted, so
#                    counting the payment again would double count
SPENDING_EFFECT = {
    "purchase": 1,
    "refund": -1,
    "income": 0,
    "transfer": 0,
    "card_payment": 0,
}
TRANSACTION_TYPES = tuple(SPENDING_EFFECT)


@dataclass(frozen=True)
class Transaction:
    txn_id: str
    date: date
    description: str
    amount_cents: int  # always positive; direction comes from txn_type
    txn_type: str = "purchase"
    account: str = ""

    @property
    def spending_effect_cents(self) -> int:
        return SPENDING_EFFECT[self.txn_type] * self.amount_cents

    @property
    def is_spending(self) -> bool:
        return SPENDING_EFFECT[self.txn_type] != 0

    def to_dict(self) -> dict:
        d = asdict(self)
        d["date"] = self.date.isoformat()
        return d

    @classmethod
    def from_dict(cls, d: dict) -> "Transaction":
        return cls(
            txn_id=d["txn_id"],
            date=date.fromisoformat(d["date"]),
            description=d["description"],
            amount_cents=int(d["amount_cents"]),
            txn_type=d.get("txn_type", "purchase"),
            account=d.get("account", ""),
        )


@dataclass(frozen=True)
class RowError:
    """A rejected CSV row, reported to the user instead of silently dropped."""

    row_number: int  # 1-based line number in the file, header = line 1
    txn_id: str
    field: str
    value: str
    reason: str

    def message(self) -> str:
        tid = f" ({self.txn_id})" if self.txn_id else ""
        return f"Row {self.row_number}{tid}: {self.field} - {self.reason}"


@dataclass(frozen=True)
class CategoryDecision:
    """Where the effective category came from, kept for transparency."""

    category: str
    source: str  # override | user_rule | rule_map | classifier | uncategorized | excluded
    detail: str = ""
