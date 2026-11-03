# Digital Wallet Transfer System (Mock)

**Author:** Eli Campbell (USF, AI in FinTech)

**Purpose:** a small fintech-class project. A transfer function moves fictional USD cents between two
fictional wallets, A and B. A repeated click or retry with the same request ID must not move the
money twice. The screen shows both balances before and after, the result and reason, and a receipt.
Built with Python, Streamlit and `unittest`. All data is mock data: no model API, no database,
no network use.

Rules live in `logic.py` (no Streamlit imports). `app.py` is the screen only. `auth.py` is the
demo sign-in (also no Streamlit imports).

## Files

```
app.py              screen: sign-in, inputs, balances, result, receipt
logic.py            transfer rules (pure function, returns a new state)
auth.py             demo sign-in: salted password hash in a local file
tests/test_logic.py transfer rule tests
tests/test_auth.py  sign-in tests
data/examples.json  fictional example requests
screenshots/        normal.png and failure.png from the running app
AI_USAGE.md         prompts, generated files, changes and actual verification
requirements.txt    pinned Streamlit version
```

## Setup (macOS)

```
cd usf-fintech-digital-wallet
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
```

Installed and tested with Python 3.14.7 and `streamlit==1.65.0` (pinned in `requirements.txt`).
The course guide names Python 3.12 or 3.13; this project was built and run on 3.14.7.

## Run the tests

```
.venv/bin/python -m unittest discover -s tests -v
```

Last recorded result: **21 tests run, 21 passed** (13 transfer-rule tests, 8 sign-in tests).

## Run the app

```
.venv/bin/python -m streamlit run app.py
```

Open http://localhost:8501. Wallets start at A = $100.00 and B = $20.00 (total $120.00).
**Reset demo** restores this and clears the request history.

### Sign in

The app asks you to sign in before it will send money. This is a demo-only extra layer; real
authentication is outside the scope of the assignment.

- Username `localhost`, password `money123` (fictional demo credentials, also shown on the sign-in screen).
- The password is never stored. On first run the app writes a salted PBKDF2 hash to
  `.wallet_credentials.json` (excluded from git).
- After signing in you are the Wallet A owner, so **From** is fixed to Wallet A. This is deliberate:
  the sign-in belongs to Wallet A, so sending from Wallet B would need its own sign-in. The
  sender selector is still shown (greyed out), and `logic.py` accepts either wallet as sender
  (covered by the unit tests, for example a B-to-A transfer).
- Five wrong passwords in one browser session lock the form until you reload the page.

## Normal-case example

Reset, sign in, then send 5000 cents from A to B with request ID `R001`.
Result: **COMPLETED**, A = $50.00, B = $70.00, total still $120.00, and a receipt is shown.
See `screenshots/normal.png`.

## Failure-case example

After the normal case, submit `R001` again unchanged: **DUPLICATE_REQUEST**, balances
unchanged, original receipt shown (`screenshots/failure.png`). Then submit `R001` with the amount
changed to 6000: **REQUEST_CONFLICT**, no balance change. Other rejections: 10001 cents from a fresh
state gives **INSUFFICIENT_FUNDS**; 0, a negative amount, a fraction or `True` gives **INVALID_AMOUNT**
(the screen can send 0 and negative values; the others are covered by unit tests).

## Total funds check

The **Total funds** card is computed from the current balances. It reads $120.00 before a transfer,
after a transfer and after a retry, and `test_total_funds_invariant_across_sequence` asserts that it
stays 12000 cents through a mixed sequence of outcomes.

## Rule order

1. Blank ID, unknown wallet, same sender/recipient, or non-USD: `INVALID_REQUEST`
2. Non-integer or non-positive amount: `INVALID_AMOUNT`
3. Known ID, identical payload: `DUPLICATE_REQUEST`
4. Known ID, changed payload: `REQUEST_CONFLICT`
5. New ID, balance too low: `INSUFFICIENT_FUNDS`
6. Otherwise: `COMPLETED`

Rejected requests do not reserve their ID (a teaching-policy choice).

## Limits

- No concurrency isolation: two simultaneous transfers are not coordinated. A real ledger needs a
  database transaction.
- No crash durability: transfer state is in memory, so a restart or a fresh browser connection
  loses all balances and history. Only the sign-in hash is saved to disk.
- Single in-memory session: state lives in one Streamlit session and is not shared.
- The sign-in is demo-grade. The demo password is printed on the sign-in screen and in `auth.py`,
  so it does not protect anything real. Fictional money only.
- The optional runtime-AI extension from the guide is not implemented.
