# Supplier Invoice Approval System

Andreana Irving — USF, AI in FinTech

## Purpose

An accounts-payable (AP) reviewer receives the same invoice more than once,
sometimes under a different filename or a different amount. This is a local
Python/Streamlit prototype that validates fictional invoice metadata and
creates **at most one** `PENDING_APPROVAL` record per supplier/invoice pair.
Resubmitting an already-seen pair — even with a changed filename or amount —
returns `DUPLICATE` and leaves the original record untouched.

`PENDING_APPROVAL` is not approval and not permission to pay. Purchase-order
matching, approval authority, invoice extraction, and real payments are out
of scope for this component.

All data in this repository is fictional classroom data. There is no model
API call and no database — state lives only in the browser's Streamlit
session while the app is running.

## Project layout

```
app.py              # Streamlit screen: inputs, result display, pending table
logic.py             # Validation, duplicate key, and check_invoice() — no Streamlit imports
tests/test_logic.py  # unittest checks for logic.py
data/                # fictional example invoices
screenshots/         # normal.png and failure.png (plus extra verification screenshots)
README.md            # this file
AI_USAGE.md          # prompts and verification record
requirements.txt     # installed Streamlit version
.gitignore           # excludes .venv, caches, and local-only files
.streamlit/config.toml  # Streamlit theme (plum and white)
```

## Setup

Requires Python and Git. The guide specifies Python 3.12 or 3.13; this
project's `.venv` was actually built with **Python 3.14.7**, which is what
is installed on this machine. The code uses no version-specific syntax,
and it was tested only on 3.14.7. It is expected to work on 3.12 or 3.13,
which the guide specifies, but that was not tested.

macOS / Linux:

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
```

Windows PowerShell:

```powershell
py -3 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

## Run the tests

```bash
.venv/bin/python -m unittest discover -s tests -v
```

Windows: `.\.venv\Scripts\python.exe -m unittest discover -s tests -v`

Actual result on this machine: **18 tests, 0 failures, 0 errors (`OK`)**.
These tests cover `logic.py` only — the duplicate/validation rules, not the
Streamlit screen.

## Run the app

```bash
.venv/bin/python -m streamlit run app.py
```

Windows: `.\.venv\Scripts\python.exe -m streamlit run app.py`

Opens at `http://localhost:8501`.

## Normal example

| Field | Value |
|---|---|
| Supplier ID | `S01` |
| Invoice number | `INV-101` |
| Amount | `100000` cents ($1,000.00) |
| Mock filename | `invoice_101.json` |

Result: **PENDING_APPROVAL**. New invoice recorded, key `S01 / INV-101`,
pending record count becomes 1, amount shown as $1,000.00, with a note that
the invoice is awaiting AP reviewer approval and has not been approved or
paid. See `screenshots/normal.png`.

## Failure (duplicate) example

Resubmit the same pair with a changed amount and filename:

| Field | Value |
|---|---|
| Supplier ID | `S01` |
| Invoice number | `INV-101` |
| Amount | `110000` cents ($1,100.00) |
| Mock filename | `resubmitted.json` |

Result: **DUPLICATE**. The existing `S01 / INV-101` record is referenced,
the count stays at 1, and the stored amount remains $1,000.00 — the new
amount and filename are shown as what was submitted, not stored. A
"Duplicate explanation" line shows the original stored amount beside the
newly submitted amount and the difference, e.g.:

```
Original stored: $1,000.00 | Newly submitted: $1,100.00 | Difference: +$100.00
```

See `screenshots/failure.png`.

## Limits

- **Duplicate detection lasts only for one browser session.** Records live
  in `st.session_state`; closing the browser, restarting the app, or a new
  connection loses them. Persistent duplicate protection across restarts
  would require a stored unique key and concurrency controls, which this
  prototype does not have.
- **The unit tests cover `logic.py`, not the screen.** `tests/test_logic.py`
  checks `check_invoice()` and `duplicate_explanation()` directly; it does
  not exercise `app.py` or anything rendered in the browser. A screen-level
  display bug (see `AI_USAGE.md`) was caught only by manually checking the
  running app, not by the test suite.
- No `APPROVED`, `PAID`, or payment-sent status exists anywhere in this
  component. A `PENDING_APPROVAL` record cannot authorize a payment.
- The duplicate key is `(supplier_id, invoice_number)` only — trimmed,
  case-sensitive. Filename and amount are never part of the key, by design:
  two different suppliers may legitimately share an invoice number, and a
  changed amount must not create a second record for the same obligation.
- This component validates intake and flags duplicates during one session.
  It does not prove restart safety, simultaneous-worker safety, or
  payment-provider idempotency.
