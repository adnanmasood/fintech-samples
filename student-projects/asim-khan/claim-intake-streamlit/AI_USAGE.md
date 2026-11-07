# AI usage record

This subfolder was built with Claude Code following the assignment's Specify, Generate,
Verify, Evaluate loop, driven from the actual build guide (10-page Assignment 7 PDF
transcription), against the existing `student-projects/asim-khan/` project's larger FastAPI
build.

## What was specified

- Interface: `check_claim(claim) -> {status, missing}`, field order policy_id, incident_date,
  description, documents; whitespace/wrong types count as missing; non-dict input returns all
  four fields missing.
- Screen: one `st.form`, inputs on the left, result on the right, matching the build guide's
  page 2 wireframes (normal and failure cases) as closely as standard Streamlit controls allow.
- Tests: the 8 cases from the build guide's page 8 table, run with `unittest discover`.
- Required modification: a next-step message for a missing `description`, exact text "Describe
  what happened and where.", without changing `missing` or the status values.

## What was generated

- `logic.py` -- `check_claim` and `next_steps_for`, following the build guide's page 6
  reference implementation closely (same loop order, same type checks), with a `NEXT_STEPS`
  lookup added for the modification.
- `tests/test_logic.py` -- the 8 page-8 cases, plus a non-dict-input boundary test and two
  tests for `next_steps_for`.
- `app.py` -- the Streamlit screen: form inputs, a results column with a status badge,
  missing-item list, next-step messages, and a present/missing checklist per field.
- `README.md`, this file, `requirements.txt`, `.gitignore`.

## Verification actually performed

- `python -m unittest discover -s tests -v` -- 11/11 tests passed on first run after writing
  `logic.py` and the test file together (no failures to debug this round; the build guide's
  own reference implementation and test table made this close to mechanical).
- `python -m streamlit run app.py` -- launched locally (`python -m pip install streamlit`
  installed `streamlit==1.65.0`, recorded in `requirements.txt`), confirmed the app served on
  `localhost:8501`.
- Both screenshots were captured from the actual running app, not mocked up: a headless
  Chromium session (Playwright) drove the real form -- filled the normal-case values, clicked
  "Check claim completeness", screenshotted the `READY_FOR_REVIEW` result; then cleared the
  incident date, set a whitespace-only description, and emptied the document list, clicked
  submit again, and screenshotted the `NEEDS_INFORMATION` result showing all three missing
  items with their next-step messages. Verified by viewing both images before saving them.

## The modification, before/after

- **Input:** `{"policy_id": "P001", "incident_date": "2026-09-20", "description": "   ",
  "documents": ["photo_01.jpg"]}`
- **Before the modification:** `check_claim` alone returns `{"status": "NEEDS_INFORMATION",
  "missing": ["description"]}` -- correct, but the screen had no human-readable instruction
  attached to that missing item.
- **After:** `next_steps_for(["description"])` returns `["Describe what happened and where."]`,
  displayed under the missing-item list. `status` and `missing` are byte-for-byte unchanged --
  confirmed by `test_missing_description_next_step` in `tests/test_logic.py`, which asserts
  both the unchanged `check_claim` output and the new message in the same test.
- **Why this belongs in the rules layer, not the screen layer:** the message is a pure function
  of which field is missing, with no dependence on Streamlit or any other display framework --
  keeping it in `logic.py` next to `check_claim` means both `app.py` and any future caller
  (tests included) get the same wording from one place, matching the build guide's own
  instruction to keep rules and the screen separate.

## Limitation observed

Streamlit's `text_input`/`text_area` widgets return `""` for an empty field rather than
`None`, which the build guide's contract does not explicitly disambiguate from a never-set
field; `check_claim` treats both identically (not a string with nonblank content after
stripping), so this didn't require special handling, but it's worth noting as a case the
contract's prose doesn't spell out and the implementation had to resolve by inference from the
whitespace-only-text rule.
