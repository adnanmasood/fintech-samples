# Card Payment Fraud Screening System (Toy Demo)

A tiny Python console demo built for a USF Fintech assignment. It reads a
fake card transaction and a mock fraud risk score, then applies simple
threshold rules to produce a decision.

**This is not a real fraud model.** All transactions, card numbers,
merchants, and risk scores are fictional and hardcoded for demonstration
purposes only.

## How it works

The code is deliberately split into two independent pieces:

1. **Mock risk scoring** (`get_mock_risk_score`) — pretends to be an ML
   model or rules engine. It just returns a hardcoded score (or `None`
   if no score exists for that transaction).
2. **Decision engine** (`decide`) — takes a risk score and applies fixed
   thresholds. It has no knowledge of how the score was produced.

Keeping these separate mirrors how real fraud systems decouple scoring
from policy, so the thresholds could change without touching the scorer,
and the scorer could be swapped for a real model without touching the
decision logic.

### Toy thresholds

| Condition                  | Decision  |
|-----------------------------|-----------|
| score < 0.30                | APPROVE   |
| 0.30 <= score < 0.70        | CHALLENGE |
| score >= 0.70                | DECLINE   |
| score missing (`None`)      | CHALLENGE (fallback) |

Every decision includes both a `decision` and a human-readable `reason`.

## Running the demo

```bash
python3 main.py
```

This prints four built-in example transactions covering:

1. Low-risk score -> APPROVE
2. Medium-risk score -> CHALLENGE
3. High-risk score -> DECLINE
4. Missing score -> CHALLENGE

## Running the tests

```bash
python3 -m unittest -v
```

Tests cover the threshold boundaries, the mock scorer, and the
end-to-end `screen_transaction` flow, using Python's built-in
`unittest` module. No third-party dependencies are required.

## Files

- `main.py` — transaction/decision data model, mock scorer, decision
  engine, and demo runner.
- `test_main.py` — unit tests (`unittest`).
- `README.md` — this file.
- `AI_USAGE.md` — notes on how AI assistance was used for this assignment.
- `.gitignore` — ignores common Python artifacts.
