"""Classifier evaluation: precision, recall, accuracy and dollar MAE.

Confusion matrix format: matrix[actual][predicted] = count.
"""
from __future__ import annotations

from decimal import ROUND_HALF_UP, Decimal


def per_class(matrix: dict[str, dict[str, int]], positive: str) -> dict:
    tp = matrix[positive].get(positive, 0)
    fn = sum(v for k, v in matrix[positive].items() if k != positive)
    fp = sum(row.get(positive, 0) for actual, row in matrix.items() if actual != positive)
    precision = Decimal(tp) / (tp + fp) if tp + fp else None
    recall = Decimal(tp) / (tp + fn) if tp + fn else None
    return {"tp": tp, "fp": fp, "fn": fn, "precision": precision, "recall": recall}


def accuracy(matrix: dict[str, dict[str, int]]) -> Decimal:
    correct = sum(matrix[c].get(c, 0) for c in matrix)
    total = sum(sum(row.values()) for row in matrix.values())
    return Decimal(correct) / total


def dollar_mae_cents(correct: dict[str, int], reported: dict[str, int]) -> Decimal:
    """Mean absolute category-total error, in cents."""
    cats = sorted(set(correct) | set(reported))
    errs = [abs(correct.get(c, 0) - reported.get(c, 0)) for c in cats]
    return (Decimal(sum(errs)) / len(errs)).quantize(Decimal("1"), rounding=ROUND_HALF_UP)
