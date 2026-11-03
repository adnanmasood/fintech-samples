# AI Usage Log

All data in this project is fictional. No model API, database, or remote service is used.

## Change: "Total funds" card and conservation invariant

**Prompt used:**
> Add a "Total funds" card computed from the current balances. Verify it reads $120.00 before a transfer, after a transfer, and after a retry. Add a unittest assertion for this invariant (sum of balances stays constant across any sequence of operations) and show it passing.

**Files modified:**
- `logic.py` — added `total_funds(state)`, which sums the balances.
- `app.py` — added a third metric card, "Total funds (mock)", that displays `total_funds(...)`.
- `tests/test_logic.py` — added `test_total_funds_invariant_across_sequence`.

**Expected result:** the card reads $120.00 before a transfer, after a completed transfer, and after an unchanged retry. The new test passes, and total funds stay at 12000 cents after every step of a mixed sequence (completed, duplicate, conflict, insufficient funds, invalid amount, invalid request, and a reverse transfer).

**Actual result observed:**
- `python3 -m unittest discover -s tests -v`: 11 tests ran, all OK, including the new invariant test.
- App check with Streamlit's AppTest: the card showed $120.00 before the transfer, $120.00 after sending 5000 cents via R001, and $120.00 after retrying R001 unchanged.

**Layer decision:** the sum is a business calculation, so it belongs in `logic.py` where it can be unit-tested without Streamlit. `app.py` only formats and displays the number.

## Change: nicer screen and a receipt instead of raw JSON

**Prompt used:**
> I want to make it look better and the receipt to look more professional rather than just code

**Files modified:** `app.py` only. The transfer rules in `logic.py` were not touched.

**What changed:** balance cards, a grouped transfer form, and a receipt card (amount, reference, from, to, currency, balances after) in place of `st.json`. A repeated request shows the same card as "Already processed".

**Actual result observed:** all transfer tests still passed. In the running app, R001 for 5000 cents showed the COMPLETED receipt; resending it showed the DUPLICATE_REQUEST receipt.

**Layer decision:** pure display, so it stays in `app.py`.

## Change: sign-in before sending money

**Prompts used:**
> I would also like to add a sign in feature before we are able to send money, with saved credentials so I can easily log into wallet A before I am able to send money, just to have a extra layer of verification

> change create account to sign in, and have the username and password on the screen below the sign in button so i can copy and paste both into the username and password. make the username be localhost and the password be money123

**Files added or modified:** `auth.py` (new), `tests/test_auth.py` (new), `app.py`, `.gitignore`.

**What changed:** `app.py` shows a Sign in screen first. `auth.py` stores a salted PBKDF2 hash (not the password) in `.wallet_credentials.json`, which is git-ignored. After signing in, **From** is fixed to Wallet A. Five wrong passwords lock the form for that session.

**Expected result:** the correct credentials sign in; anything else is rejected; the password is not readable in the saved file; transfers are only possible after sign-in.

**Actual result observed:** 8 sign-in tests pass (right and wrong credentials, no plain-text password, salt differs per hash, one demo account only). In the browser, signing in with the demo credentials opened the transfer screen and R001 completed.

**Layer decision:** sign-in rules are logic, so they live in `auth.py` with no Streamlit imports and are unit-tested. `app.py` only draws the form. The sign-in is outside the assignment scope (real authentication is a later workflow step) and is demo-grade: the demo password is displayed on screen by request.

## Check: compliance pass against the build guide (pages 62-71)

**Prompt used:**
> I just uploaded a file, it was the instructions for the project. Only look at page 62-71. Make sure to double check that the project fits all of the guidlines, and use the updated version of the app to complete the rest. Make sure to update all of the information in usf-fintech-digital-wallet folder with updated screenshots, and all of the required updated information

**Gaps found and fixed:**
- The screen showed no before/after balances; added a "Before ... After ... Total funds" line under the result.
- The result text had been reworded (for example "Completed"); it now shows the exact status codes (COMPLETED, DUPLICATE_REQUEST, and so on).
- The currency was fixed in code; added a Currency field (USD) to the form.
- Card labels lost their "(mock)" marking; restored.
- The guide's starter test (`moved_balances` conserves money) and reason-text checks were missing; added `test_money_is_conserved` and `test_reasons_are_readable_text`.
- `screenshots/` was empty; captured `normal.png` and `failure.png` from the running app.
- The sign-in hash file was moved out of `data/` (guide: fictional examples only) to `.wallet_credentials.json` and kept out of git.
- README rewritten with author, purpose, exact commands, examples and limits.

**Failure investigated:** while capturing the normal screenshot, the "Before: A $100.00 | B $20.00" line rendered wrongly, because Streamlit read the text between two `$` signs as math. Smallest cause: unescaped `$` in `st.markdown`. Fix: escape `$` in that line. Rechecked in the browser: the line now reads correctly.

**Verification record (actual output):**
- `.venv/bin/python -m unittest discover -s tests -v`: 21 tests ran, OK (13 in `test_logic.py`, 8 in `test_auth.py`).
- App check with Streamlit's AppTest after signing in: changing the amount field alone left balances at A=10000, B=2000 (no transfer until submit); R001/5000 gave COMPLETED (A=5000, B=7000); the same again gave DUPLICATE_REQUEST (unchanged); R001/6000 gave REQUEST_CONFLICT (unchanged); R009/10001 gave INSUFFICIENT_FUNDS; amounts 0 and -1 gave INVALID_AMOUNT.
- Browser check on http://localhost:8501: screenshots show COMPLETED with A $50.00, B $70.00, total $120.00, then DUPLICATE_REQUEST with balances unchanged.

**Not done:** the optional runtime-AI extension (up to 10 bonus points) is not implemented. Concurrency isolation and crash durability are not provided (see README limits).
