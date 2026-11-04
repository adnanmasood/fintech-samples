# AI Usage Record

**Tool:** Claude (Anthropic) · **Loop used:** Specify → Generate → Verify → Evaluate

> Before submitting: rerun the commands below on your own machine and replace the "Actual result"
> lines with your own output, date and test count.

## 1. Specify: what I asked for

Prompt (summarized):
> Use the attached build guide (Lecture 4 Artifacts, Bank Account Onboarding System) to build a locally
> running application that looks like a bank's onboarding system, with separate screens for the pass,
> fail and under-review scenarios, and complete the project requirements.

Constraints taken from the guide: Python + Streamlit + unittest; `app.py` for the screen and `logic.py` for the rules;
fictional data only; no model API and no database; status is `READY_FOR_VERIFICATION` or `REVIEW` with the
page 4 reason codes and order; never create or approve an account.

**Design decision (screen layer only):** the guide defines two statuses, and the request asked for three
scenario screens. `REVIEW` results are therefore split for display: *Fail* means a missing or invalid field,
and *Under review* means valid records that disagree. `outcome_category()` only selects the screen. The
status and reason codes come unchanged from `check_onboarding()`.

## 2. Generate: files produced

| File | Purpose |
|---|---|
| `logic.py` | `normalized_name`, `checked_dob`, `check_onboarding`, `outcome_category`, `comparison_checklist` |
| `tests/test_logic.py` | 24 unittest checks: page 8 table, boundaries, modification, data-file expectations |
| `data/examples.json` | 6 fictional scenarios with expected results |
| `app.py` | Streamlit screens: scenario launcher → side-by-side form → Pass / Fail / Under review result |
| `.streamlit/config.toml` | Light bank theme |
| `README.md`, `requirements.txt`, `.gitignore`, `AI_USAGE.md` | Submission documents |
| `screenshots/*.png` | Captured from the running app with a headless browser |

## 3. Verify: commands and actual results

```
.venv/bin/python -m unittest discover -s tests -v
```
Actual result (build session, 2026-11-02, Python 3.13, Streamlit 1.66.1): **Ran 24 tests … OK (24 passed / 24 run).**

Browser checks (app running on localhost:8501):

| Input | Expected | Actual |
|---|---|---|
| Dana Lee / 1999-04-12 vs Dana Lee / 1999-04-12 | READY_FOR_VERIFICATION, [] | READY_FOR_VERIFICATION, [] (`screenshots/normal.png`) |
| Mock ID name changed to Dana Li | REVIEW, [NAME_MISMATCH] | REVIEW, [NAME_MISMATCH], Under review screen (`screenshots/failure.png`) |
| Mock ID DOB blank | REVIEW, [MISSING_ID_DOB] | REVIEW, [MISSING_ID_DOB], Fail screen, comparisons "Not compared" (`fail_missing_dob.png`) |
| Signup DOB 1999-02-30 typed by hand | REVIEW, [INVALID_SIGNUP_DOB] | REVIEW, [INVALID_SIGNUP_DOB], no traceback (`invalid_date.png`) |
| Mock ID name `" DANA LEE "` | READY_FOR_VERIFICATION, original string shown | READY_FOR_VERIFICATION, `" DANA LEE "` shown in quotes (`modification_dana_lee.png`) |

## 4. Investigated failure (guide prompt 4)

- **Input:** Opened the Pass scenario in the form ("Open in form").
- **Expected:** The form opens prefilled with Dana Lee / 1999-04-12.
- **Got:** `AttributeError: 'function' object has no attribute 'get'` in `go_to_form`.
- **Smallest cause:** The app stored the field values under `st.session_state.values`. Streamlit's
  session state behaves like a dict, so `.values` resolved to the built-in `values()` method rather than
  the stored dictionary.
- **Fix:** Renamed the key to `st.session_state["field_values"]` and used bracket access. The fix
  belongs to the screen layer (`app.py`). `logic.py` and the tests were unaffected, and the full suite still passes.
- **Re-verified:** The headless browser walk through every screen ran with 0 tracebacks in the server log
  and 0 browser console errors.

A second display issue was also found and fixed in the screen layer: the blank-field placeholder text
`1999-04-12` looked like a real value in an empty ID DOB box. The placeholders now read `YYYY-MM-DD`.

## 5. Evaluate: the small modification (guide page 6)

- **Change:** Added a **ID name → " DANA LEE "** button on the form that fills only the mock ID name.
- **Input used:** Signup `Dana Lee / 1999-04-12`, mock ID `" DANA LEE " / 1999-04-12`.
- **Expected:** `READY_FOR_VERIFICATION`, with the original strings unchanged on screen.
- **Actual:** `READY_FOR_VERIFICATION`, `reasons = []`. The result screen shows `" DANA LEE "` with its spaces.
- **Test added:** `ModificationTests.test_padded_uppercase_id_name_still_ready` (also asserts the input is not mutated).
- **Layer:** The button is a **screen** change because it only supplies an input. The rule it exercises
  (whitespace and case normalization) already lives in the **rules** layer (`normalized_name`), so no rule
  changed. The scenario is also stored as **data** in `data/examples.json`.

## 6. One rule I can explain

`normalized_name` only trims, collapses whitespace and case-folds. It does not fuzzy-match, because a
compliance-first process must not decide on its own that "Dana Li" is "Dana Lee". A typo and a different
person look the same to software, so a human reviewer resolves the conflict against source evidence.

## Optional AI extension

Not implemented. The required application runs without any model API.
