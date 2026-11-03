# AI Usage

Student: Huei-En Cho. AI tool: Claude Code (Anthropic), in a CLI chat workflow.

## Prompts used (summarized)

1. Refactor the project into `app.py` + `logic.py` + `tests/` + `data/` + `screenshots/`
   with the exact screening rules, rule order, boundaries (0.20, 0.80), Streamlit form
   requirements, fictional sample data and unittest coverage; no real model API, no
   database; do not initialize Git.
2. Set up `.venv`, install Streamlit, pin the exact version in `requirements.txt`,
   and run the tests with the `.venv` Python.
3. Run the app with `.venv/bin/python -m streamlit run app.py`.
4. Check the `screenshots/` folder (twice).
5. Review the project for submission and update README.md and AI_USAGE.md.

## What Claude built

- `logic.py`: `screen_transaction()` with validation first, then the ordered rules.
- `app.py`: Streamlit form, sample-case dropdown, separate error vs. result display,
  CHALLENGE warning, score shown as unavailable on timeout, nothing cached between runs.
- `tests/test_logic.py` (22 tests), `data/sample_transactions.json` (8 fictional cases).
- README.md, AI_USAGE.md, requirements.txt (`streamlit==1.66.1`), .gitignore.
- It replaced the earlier console demo (`main.py`, `test_main.py`, thresholds 0.30/0.70).

## What I manually tested

Run in the Streamlit app (screenshots in `screenshots/`):
- `T101`, 4500 cents, score 0.1, no flags → APPROVE / LOW_RISK (`screenshots/normal.png`).
- Same input with Model timeout checked → CHALLENGE / MODEL_UNAVAILABLE, score shown
  as unavailable, "verification NOT yet succeeded" warning (`screenshots/failure-1.png`).
- Same input with Card blocked and Model timeout checked → DECLINE / CARD_BLOCKED
  (`screenshots/failure-2.png`).

## Change I verified

The decision rules changed from the original thresholds (approve < 0.30, decline ≥ 0.70)
to approve < 0.20, challenge 0.20–<0.80, decline ≥ 0.80, plus the rule that a blocked
card overrides score and timeout. Verified by unit tests for exactly 0.20 and 0.80 and
for blocked+timeout, and by `screenshots/failure-2.png`.

## Actual test results

`.venv/bin/python -m unittest discover -s tests -t .` → **Ran 22 tests, OK (22 passed,
0 failed)**. Python 3.14.7, Streamlit 1.66.1.

## Disclosure

Educational demo with fictional data only; not a production fraud system.
