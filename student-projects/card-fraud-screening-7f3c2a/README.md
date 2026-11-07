# Card Payment Fraud Screening System

**Author:** Huei-En Cho

## Purpose

A small Streamlit demo for a USF Fintech assignment. It screens a fictional card
transaction and returns `APPROVE`, `CHALLENGE`, `DECLINE` or `INVALID_INPUT` with a
reason. The risk score is a **mock value**, not a real fraud probability. All data is
fictional; there is no real model API and no database.

## Setup

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
```

## Run

```bash
.venv/bin/python -m streamlit run app.py
```

Then open http://localhost:8501.

## Test

```bash
.venv/bin/python -m unittest discover -s tests -t .
```

## Files

- `logic.py` — `screen_transaction(transaction)`; all business rules.
- `app.py` — Streamlit screen; calls `logic.py` and holds no decision rules.
- `tests/test_logic.py` — unittest suite (22 tests).
- `data/sample_transactions.json` — fictional sample cases (also checked by a test).
- `screenshots/` — app screenshots.

## Input

`transaction_id` (nonblank string), `amount_cents` (positive integer, no booleans or
fractions), `card_blocked` (bool), `risk_score` (finite number 0–1, or null),
`model_timeout` (bool).

## Rules (applied in this order)

1. Invalid ID, amount or flag → `INVALID_INPUT`, naming the field
   (`INVALID_TRANSACTION_ID`, `INVALID_AMOUNT`, `INVALID_CARD_BLOCKED`, `INVALID_MODEL_TIMEOUT`).
2. `card_blocked` → `DECLINE / CARD_BLOCKED` (overrides score and timeout).
3. `model_timeout` or null score → `CHALLENGE / MODEL_UNAVAILABLE`.
4. Present score that is non-numeric, non-finite, < 0 or > 1 → `INVALID_INPUT / INVALID_SCORE`.
5. score < 0.20 → `APPROVE / LOW_RISK`.
6. 0.20 ≤ score < 0.80 → `CHALLENGE / VERIFICATION_REQUIRED`.
7. score ≥ 0.80 → `DECLINE / HIGH_RISK`.

## Examples

**Normal** — `T101`, 4500 cents, not blocked, mock score 0.1, no timeout
→ `APPROVE / LOW_RISK` (`screenshots/normal.png`).

**Failure** — `T101`, 4500 cents, card blocked, timeout selected
→ `DECLINE / CARD_BLOCKED`; a blocked card overrides the timeout
(`screenshots/failure-2.png`). With the card unblocked, the same timeout gives
`CHALLENGE / MODEL_UNAVAILABLE`, and the app states that verification is required and
has NOT yet succeeded (`screenshots/failure-1.png`).

## Limitations

- The score is typed in by hand; nothing computes a real risk score.
- A CHALLENGE only reports that verification is needed; no verification step exists.
- No persistence, authentication or real card data; results are not stored.
- Amount is in cents with no currency handling (display assumes USD).
- Per the specified rule order, a blocked card or a timeout is decided before the score
  is checked, so an invalid score alongside either is not reported as `INVALID_SCORE`.
