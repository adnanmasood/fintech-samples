# Sample claim documents and demo data

Six fictional PDF documents, written so the mock fact extractor (`extraction.py`)
finds something real when you upload one -- dollar amounts, an ISO-format date
(`YYYY-MM-DD`, the only date shape the regex matches), and an incident keyword --
plus `claims.json` (five full claim scenarios and three validation-failure cases) and
`seed_demo_data.py`, which turns that data into a populated, running system with one
command.

The fictional sample PDFs themselves are not included in this submission snapshot --
see the live repo (github.com/i-asimkhan/harborclaim-insurance-intake/tree/main/sample_data)
for those, plus `docs/screenshots/`. `claims.json` and `seed_demo_data.py` below are
complete and runnable as-is once you supply your own copies of the six PDFs named in
`claims.json`.

## `claims.json`

Two sections:

- **`scenarios`** (5) -- real claims to seed, covering every system state on
  purpose: a straightforward complete claim later **APPROVED**, a complete
  claim later **DECLINED** (proving the decision is a genuine independent
  judgment call, not predetermined by completeness), a complete claim routed
  **NEEDS_MORE_REVIEW** (the third outcome, not just a binary), one
  **NEEDS_INFORMATION** claim missing its incident date, and one
  **NEEDS_INFORMATION** claim missing documents entirely (the other way a
  claim can be incomplete). Three different fictional claimants, one of whom
  files twice, so "My Claims" has more than one entry to look at.
- **`validation_failures`** (3) -- input that must *never* become a stored
  claim: a policy ID over the length limit, a future incident date, a
  disallowed file type. `seed_demo_data.py` submits these too and fails
  loudly if one is ever accepted instead of rejected.

## Seed a running instance

```bash
# Server must already be running separately:
.venv/Scripts/python.exe -m uvicorn app:app --port 8123

# Then, from another terminal:
.venv/Scripts/python.exe sample_data/seed_demo_data.py --reset
```

This makes **real HTTP requests** against the live server -- every seeded
claim genuinely passes through `POST /claims` (completeness check,
`validation.py`, `extraction.py`, `summary.py`, the notification stub) and
every decision genuinely passes through `POST /adjuster/claims/{id}/decision`
(including the separation-of-duties check), exactly as a real browser
submission would. Nothing is inserted directly into the database. Login is
by injected, properly-signed session cookie (same technique as
`tests/test_ui.py` and the documentation screenshots) rather than five real
Google sign-ins or a password you'd have to remember between runs -- that's
what makes `--reset` safe to run repeatedly.

The script prints a result line per scenario (claim ID, actual vs. expected
status, decision) and confirms each validation-failure case was genuinely
rejected, not silently accepted.

## Try a single document by hand

Run the app, sign in, go to **Submit a claim**, attach a fictional PDF or
`.txt` file of your own with a dollar amount and an ISO date in it. After
submitting, open the claim -- the **Extracted facts** table shows what the
regex found, and the **Adjuster summary** restates it in a sentence. Both
are tagged `MOCK` on the page; see `../MOCKS.md`.
