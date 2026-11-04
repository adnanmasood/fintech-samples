# AI Usage Record

**Author:** Andreana Irving 
**Tool:** Claude Code, model Claude Sonnet 5 (`claude-sonnet-5`) — used for all file generation in this project
**Also used:** Claude, in a separate chat — as a step-by-step guide for terminal commands, approval decisions, and checking my screenshots against the guide
**Project:** Supplier Invoice Approval System (`usf-fintech-supplier-invoice`)
**Last updated:** 2026-11-03

This file records the actual prompts used to build this project, the files
each one produced, the one small modification and its verification, and
what I checked myself. Test counts below are reported as observed when I
ran them — nothing here is invented.

## 1. Prompts, in order

### Prompt 1 — Specify
> I am Andreana Irving, a fintech student building Supplier Invoice
> Approval System. Use Python, Streamlit and unittest. Keep app.py for the
> screen and logic.py for business logic. Use fictional data, no model API
> and no database. Read this guide and list the required inputs, outputs
> and ordered rules. Do not code yet. Verify by checking your list against
> pages 4 and 8.

Claude read the build guide PDF and listed required inputs (`supplier_id`,
`invoice_number`, `amount_cents`, `filename`, `records`), the output shape
(`check_invoice(records, invoice) -> (new_records, result)`), and seven
ordered rules. No code was written. I checked the list against page 4
(data contract / rule table) and page 8 (test case table) myself — it
matched.

### Prompt 2 — Generate (core logic)
> Implement check_invoice(records, invoice) -> (new_records, result).
> Validate nonblank supplier_id/invoice_number and a positive integer
> amount_cents, rejecting bool. Trim identifiers but preserve case. Key by
> the supplier/invoice tuple. New keys produce PENDING_APPROVAL; existing
> pairs produce DUPLICATE with the unchanged original record, even when
> amount or filename changes. Invalid input has no state effect. No
> payment functionality. Create fictional files in data/ and implement
> logic.py. Do not add the screen yet. Add unittest checks for page 8. Run
> them and show the actual result. Verify by comparing normal, failure and
> boundary outputs with the expected table.

Generated: `logic.py` (`invoice_key`, `check_invoice`), three fictional
files in `data/` (`invoice_101.json`, `resubmitted.json`,
`invoice_s02.json`), and `tests/test_logic.py` with 16 tests covering the
page 8 table. Actual result when run:

```
Ran 16 tests in 0.000s
OK
```

I ran this myself and compared each case to the page 8 table — normal,
repeat, changed-filename/amount duplicate, second supplier, blank input,
amount 0/-1/1.5/True, and trimmed-whitespace duplicate all matched.

### Prompt 3 — Generate (screen)
> Build one invoice form and a pending-invoice table with record count,
> status and reason. Store records once in st.session_state and preserve
> them across reruns. Include Reset demo. For duplicates show the original
> invoice and its submitted amount. Use a form and its submit button; call
> logic.py rather than copy its rules. Label mock values. Verify by
> running the app and reproducing both page 2 sketches; show status and
> reasons as readable text.

Generated: `app.py` — one `st.form` with Supplier ID / Invoice number /
Amount / Mock filename, a "Check invoice" submit button, a result panel
(`st.success`/`st.warning`/`st.error` per status), a pending-record count,
an accepted-invoices table, and a "Reset demo" button. It calls
`check_invoice()` from `logic.py`; no rules are duplicated in `app.py`.

Claude offered to drive the app itself with a browser-automation tool to
reproduce the page 2 sketches. I turned that down — no extra tools were
installed — and checked the running screen myself instead (see §3).

### Reviewer-approval line (follow-up to Prompt 3)
After Prompt 3, I compared the running screen to page 2 and noticed it
didn't say a reviewer still needs to approve the invoice (page 2: "explain
that a reviewer still needs to approve it"). I asked Claude to add one
line to the `PENDING_APPROVAL` result, in `app.py` only. It added: "This
invoice is awaiting AP reviewer approval and has not been approved or
paid." `logic.py` was not touched.

### Small modification — test first (page 6 "Your small modification")
I asked for a new function `duplicate_explanation(existing_invoice,
submitted_invoice)` returning the original stored amount, the newly
submitted amount, and the difference in cents — tests first, no
implementation yet, no changes to `logic.py` or `app.py`. Claude added two
tests to `tests/test_logic.py`, importing `duplicate_explanation` inside
the test methods (not at module scope) so the existing tests would still
run.

I ran the suite myself before any implementation existed:

```
Ran 18 tests in 0.000s
FAILED (errors=1)
```

17 passed; `test_duplicate_explanation_returns_original_submitted_and_difference`
errored with `ImportError: cannot import name 'duplicate_explanation' from
'logic'` — expected, since the function didn't exist yet. The test was
asking for something the code couldn't do.

### Prompt 4 — Investigate a failed check
> This is the input I used: stored invoice S01/INV-101 at 100000 cents
> (invoice_101.json), resubmitted as S01/INV-101 at 110000 cents
> (resubmitted.json). I expected: duplicate_explanation to return
> original_amount_cents 100000, submitted_amount_cents 110000 and
> difference_cents 10000. I got: ImportError: cannot import name
> 'duplicate_explanation' from 'logic' in
> test_duplicate_explanation_returns_original_submitted_and_difference.
> Ran 18 tests, FAILED (errors=1). Find the smallest cause, explain it,
> and propose a correction. Add a test that fails before the correction.
> Verify by rerunning that test and the full suite; do not remove an
> assertion to make a failure disappear.

Smallest cause: `duplicate_explanation` was never added to `logic.py` —
only `check_invoice`, `invoice_key`, and two private validators existed.
Correction: added a read-only `duplicate_explanation()` to `logic.py`
returning `original_amount_cents`, `submitted_amount_cents`, and
`difference_cents`; `check_invoice` was not changed. The failing test
already existed from the previous step, so no new test was added — that
existing test was the one required to fail before, and pass after, the
fix.

I reran the suite myself after the fix:

```
Ran 18 tests in 0.000s
OK
```

18 passed, 0 errors.

### Duplicate explanation on screen
I asked Claude to call `duplicate_explanation()` from `app.py` on a
`DUPLICATE` result and show a "Duplicate explanation" line with the
original amount, the submitted amount, and the signed difference in
dollars, e.g. `Original stored: $1,000.00 | Newly submitted: $1,100.00 |
Difference: +$100.00`. Change scoped to `app.py` only; Claude did not run
the app for this step — I checked it myself.

### Display bug — found by manual check, not by the tests
I found this myself during a manual check of the running screen, with
help from Claude in a separate chat reviewing my screenshot: the
Duplicate explanation line rendered wrong, with the `$` signs disappeared
and the text between the first two amounts shown in italics. I reported
it to this Claude Code session the same way as Prompt 4 (input used,
expected, actual). Claude's cause analysis: Streamlit renders `st.write`
text as Markdown, and a line with three literal `$` characters gets the
first pair parsed as inline LaTeX math, swallowing the text between them;
lines with only one `$` were unaffected. Fix: escape `$` → `\$` at every
Markdown call site that shows a dollar amount, in `app.py` only; the
plain unescaped formatter stayed in use for the `st.dataframe` table,
which does not parse Markdown.

The unit tests did not catch it because they only cover `logic.py`, not
the screen.

### Screen styling
I asked Claude Code to add a plum theme in `.streamlit/config.toml` and
polish `app.py` with bordered cards, a primary Check invoice button, a
pending count metric, a How It Works expander, a subtitle with my name,
wide layout and title-case headings. I used Claude chat for design
suggestions and color choices. `logic.py` and the tests were not changed.
After the changes I rechecked the normal, duplicate, different-supplier
and invalid cases in the browser, reran the tests (18 OK), and retook
`normal.png` and `failure.png`.

### Prompt 5 — Prepare a reproducible submission
> Write README.md with my name, purpose, exact setup/test/run commands,
> normal and failure examples, and limits. Record my prompts, generated
> files, modification and actual verification in AI_USAGE.md. Add
> .gitignore and an exact installed Streamlit version in requirements.txt.
> Do not invent test results. Verify by listing the required files and
> running the documented commands.

Produced this file, `README.md`, `.gitignore`, and `requirements.txt`
(exact installed Streamlit version read from package metadata, not typed
from memory — see §4). The Streamlit app itself was not run as part of
this step; I ran/checked the app myself throughout the project.

## 2. Generated files (cumulative)

| File | Produced by |
|---|---|
| `logic.py` | Prompt 2; extended (Prompt 4 fix) with `duplicate_explanation` |
| `data/invoice_101.json`, `data/resubmitted.json`, `data/invoice_s02.json` | Prompt 2 |
| `tests/test_logic.py` | Prompt 2 (16 tests); extended with `DuplicateExplanationTests` (small modification, 2 tests, 18 total) |
| `app.py` | Prompt 3; extended with the reviewer-approval line, the Duplicate explanation display, and the `$`-escaping fix |
| `README.md`, `.gitignore`, `requirements.txt` | Prompt 5 |
| `AI_USAGE.md` | Prompt 5 (this file; replaces an earlier template version) |
| `screenshots/*.png` | Captured by me, not Claude, while checking the running app myself |

## 3. My own verification (not Claude's)

- Compared Claude's page-4/page-8 rule list against the guide myself
  (Prompt 1).
- Ran `unittest discover` myself after Prompt 2, after the small
  modification (before the fix), after the Prompt 4 fix, and again before
  writing this file. Actual counts are reported in §1.
- Declined Claude's offer to install Playwright or use a Chrome-automation
  extension to drive the Streamlit screen; checked the running app in my
  own browser instead, each time a screen change was made.
- Found the Markdown `$`-escaping display bug myself, by looking at the
  running screen — the test suite (logic-only) did not and could not catch
  it.
- Confirmed the final Duplicate explanation screen reads exactly
  `Original stored: $1,000.00 | Newly submitted: $1,100.00 | Difference:
  +$100.00`, with the pending record count staying at 1 and the
  accepted-invoices table unchanged.

## 4. Dependency version

Read from installed package metadata (`importlib.metadata.version`), not
typed from memory:

```
streamlit==1.66.1
```

Recorded in `requirements.txt`.

## 5. Limitations noted

- Claude Code's own knowledge has a training cutoff; the Streamlit version
  and Python version in this project are both taken from the actually
  installed environment (see README.md), not assumed.
- AI output was not treated as authoritative on the assignment's rules —
  every rule Claude proposed was checked against the guide's own pages (4,
  6, 8) before being accepted, and the one real bug in the project (the
  Markdown `$` rendering issue) was found during my own manual check with
  help from Claude chat, not by the automated tests.
- `check_invoice` and `duplicate_explanation` produce `INVALID_INPUT`,
  `PENDING_APPROVAL`, and `DUPLICATE` only. No `APPROVED`, `PAID`, or
  payment-sent status exists anywhere in this prototype.
