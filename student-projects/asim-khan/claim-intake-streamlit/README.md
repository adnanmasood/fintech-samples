# Claim completeness -- Streamlit minimum

Asim Khan. Assignment 7 (USF FIN 6934, AI in Finance), Streamlit-compliant minimum.

## Purpose

A claims adjuster needs a case with the basic facts and evidence labels present before review
can begin. This component checks a fictional claim and lists exactly what is missing. It is a
completeness checker, not a coverage, denial, or payment decision -- source documents and a
human adjuster remain authoritative.

## Relationship to the rest of this project

This folder sits alongside the project's larger FastAPI + Jinja2 build at the top level of
`student-projects/asim-khan/` (see that top-level `README.md`'s "Tech stack, and why" section
for the reasoning). The assignment's own build guide specifies a one-screen Streamlit app with
no database, no auth, and no file uploads; this subfolder implements exactly that, scored
shape, standalone from the larger build. `logic.check_claim` here is a clean-room
implementation of the same data contract as the top-level `main.py` -- same interface, same
field order -- not a copy, because the rules in each are written and tested independently.

## Setup

```bash
# macOS
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt

# Windows PowerShell
py -3 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

## Run

```bash
# macOS
.venv/bin/python -m streamlit run app.py
# Windows PowerShell
.\.venv\Scripts\python.exe -m streamlit run app.py
```

Then open <http://localhost:8501>.

## Test

```bash
# macOS
.venv/bin/python -m unittest discover -s tests -v
# Windows PowerShell
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
```

11 tests, all passing: the 8 cases from the build guide's page 8 test table, a non-dictionary
input boundary case, and two tests for the required modification (next-step message).

## Data contract

`check_claim(claim)` returns `{"status": "READY_FOR_REVIEW" | "NEEDS_INFORMATION", "missing":
[...]}`. Required: nonblank string `policy_id`, `incident_date`, `description`, plus a
`documents` list with at least one nonblank string label. Whitespace-only text and wrong types
count as missing. `missing` lists field names in order: `policy_id`, `incident_date`,
`description`, `documents`. The function is pure -- it reads the input claim without modifying
it, and returns nothing beyond `status` and `missing` (no approval, denial, or payout).

## Normal example

Policy ID `P001`, incident date `2026-09-20`, description "Minor water damage in kitchen",
one document `photo_01.jpg` -> `READY_FOR_REVIEW`, `missing=[]`. See
`screenshots/normal.png`.

## Failure example

Same claim with incident date cleared, description blank/whitespace-only, and no documents ->
`NEEDS_INFORMATION`, `missing=["incident_date", "description", "documents"]`, each with a
human-readable next step. See `screenshots/failure.png`.

## The required modification

Added a human-readable next-step message for each missing field via `logic.next_steps_for`.
For a missing `description`, the message is exactly "Describe what happened and where." --
`missing=["description"]` and the `NEEDS_INFORMATION` status are unchanged by the modification;
only the screen's displayed text gains an actionable instruction. Covered by
`tests/test_logic.py::NextStepsModificationTests`.

## Limits

- Document names are fictional labels, not real file uploads; a document name does not prove a
  file exists or establish the facts it claims to support.
- No date-format validation beyond "nonblank text" -- `incident_date` is not parsed or checked
  against a calendar.
- No policy lookup, no coverage or eligibility check, no state.
- `check_claim` is stateless; `app.py` keeps only the latest submitted claim and result in
  `st.session_state` for display between reruns, not as a database.
