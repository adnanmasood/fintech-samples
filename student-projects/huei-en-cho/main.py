"""
Card Payment Fraud Screening System (toy demo).

USF Fintech assignment. This is NOT a real fraud model. All data is
fictional and all thresholds are made up for demonstration purposes.

The program is split into two concerns on purpose:
  1. A mock "risk scorer" that pretends to be an ML/rules engine and
     just hands back a canned score for a transaction.
  2. A decision engine that only knows about thresholds -- it has no
     idea how the score was produced. This separation mirrors how a
     real fraud system keeps scoring and policy decoupled.
"""

from dataclasses import dataclass
from typing import Optional


# ---------------------------------------------------------------------------
# Domain objects
# ---------------------------------------------------------------------------

@dataclass
class Transaction:
    """A fictional card transaction."""
    transaction_id: str
    card_last4: str
    amount: float
    currency: str
    merchant: str


@dataclass
class Decision:
    """The outcome of running a transaction through the decision engine."""
    decision: str
    reason: str


# ---------------------------------------------------------------------------
# Mock risk scoring (kept separate from decision rules)
# ---------------------------------------------------------------------------

# Toy score of 0.0 (looks totally safe) to 1.0 (looks totally fraudulent).
# In a real system this would come from an ML model or rules engine.
def get_mock_risk_score(transaction_id: str) -> Optional[float]:
    """
    Return a fake risk score for a transaction id.

    This stands in for a real fraud-scoring service. Scores are hardcoded
    per transaction id so the demo is reproducible. An unknown id returns
    None, which simulates the scorer being unavailable or not having
    scored this transaction yet.
    """
    mock_scores = {
        "txn-low-risk": 0.05,
        "txn-medium-risk": 0.45,
        "txn-high-risk": 0.92,
        # "txn-missing-score" intentionally has no entry -> None
    }
    return mock_scores.get(transaction_id)


# ---------------------------------------------------------------------------
# Decision engine (only knows about thresholds, not how scores are made)
# ---------------------------------------------------------------------------

APPROVE_BELOW = 0.30   # score < 0.30            -> APPROVE
CHALLENGE_BELOW = 0.70  # 0.30 <= score < 0.70   -> CHALLENGE
# score >= 0.70                                  -> DECLINE


def decide(risk_score: Optional[float]) -> Decision:
    """
    Apply toy fraud thresholds to a risk score and return a Decision.

    Rules:
      - score is None            -> CHALLENGE (fallback: score missing)
      - score < 0.30              -> APPROVE
      - 0.30 <= score < 0.70      -> CHALLENGE
      - score >= 0.70             -> DECLINE
    """
    if risk_score is None:
        return Decision(
            decision="CHALLENGE",
            reason="Risk score unavailable; defaulting to manual challenge as a safe fallback.",
        )

    if risk_score < APPROVE_BELOW:
        return Decision(
            decision="APPROVE",
            reason=f"Risk score {risk_score:.2f} is below the {APPROVE_BELOW:.2f} approve threshold.",
        )

    if risk_score < CHALLENGE_BELOW:
        return Decision(
            decision="CHALLENGE",
            reason=(
                f"Risk score {risk_score:.2f} is between {APPROVE_BELOW:.2f} "
                f"and {CHALLENGE_BELOW:.2f}, so extra verification is required."
            ),
        )

    return Decision(
        decision="DECLINE",
        reason=f"Risk score {risk_score:.2f} is at or above the {CHALLENGE_BELOW:.2f} decline threshold.",
    )


def screen_transaction(transaction: Transaction) -> Decision:
    """Look up a transaction's mock risk score and turn it into a Decision."""
    risk_score = get_mock_risk_score(transaction.transaction_id)
    return decide(risk_score)


# ---------------------------------------------------------------------------
# Demo
# ---------------------------------------------------------------------------

DEMO_TRANSACTIONS = [
    Transaction(
        transaction_id="txn-low-risk",
        card_last4="4242",
        amount=12.50,
        currency="USD",
        merchant="Fictional Coffee Co.",
    ),
    Transaction(
        transaction_id="txn-medium-risk",
        card_last4="1881",
        amount=340.00,
        currency="USD",
        merchant="Fictional Electronics Outlet",
    ),
    Transaction(
        transaction_id="txn-high-risk",
        card_last4="0007",
        amount=2999.99,
        currency="USD",
        merchant="Fictional Overseas Gift Cards",
    ),
    Transaction(
        transaction_id="txn-missing-score",
        card_last4="5150",
        amount=75.00,
        currency="USD",
        merchant="Fictional Bookstore",
    ),
]


def run_demo() -> None:
    print("=== Card Payment Fraud Screening System (toy demo) ===")
    print("All data below is fictional. This is not a real fraud model.\n")

    for transaction in DEMO_TRANSACTIONS:
        result = screen_transaction(transaction)
        print(f"Transaction: {transaction.transaction_id}")
        print(f"  Merchant:  {transaction.merchant}")
        print(f"  Amount:    {transaction.amount:.2f} {transaction.currency}")
        print(f"  Decision:  {result.decision}")
        print(f"  Reason:    {result.reason}")
        print()


if __name__ == "__main__":
    run_demo()
