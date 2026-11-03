# AI Usage

Tool: Claude Code (model: Claude Sonnet 5.5), used in one working session.

## Key prompts

1. Initial request: build a keyword retrieval component for an Investment
   Research Assistant (Verity Research Systems) that searches fictional local
   text reports and returns an excerpt with filename and line number, or
   `NOT_FOUND`. No LLM or vector database. Standard-library Python console
   tool, three fictional reports, `main.py` with a built-in demo,
   `test_main.py` using `unittest`, a README, and tests for a normal input and
   a failure. Work only in this folder.
2. "Update the matching to include relevant partial matches as well. Empty
   inquiries should still give NOT_FOUND."
3. "Undo my previous request concerning partial matches."
4. "Run the examples and tests and explain any failures" (run twice, and after
   most changes).
5. Manual queries (`flag`, `supply`, `time`, `rat`) to probe behavior.
6. "Before changing anything, present some examples of false matches that
   adding the '-ier/-y' endings may cause", then "go with option 1, narrow
   rule".
7. "Searching supply should return line 4 from the actual text, not the title".
8. "Run more examples and tests to identify any remaining weak points ...
   explain them in simple terms with a suggested course of action", then
   "Make fixes 1 and 3".
9. Prepare the folder for submission per the assignment checklist.

## What Claude Code built

- `main.py`: keyword search over `reports/*.txt` with stopword removal,
  whole-word matching, light stemming, `search()` (formatted string) and
  `retrieve()` (dict), CLI, and built-in demo.
- `test_main.py`: 13 `unittest` tests (normal input, `NOT_FOUND` failure
  cases, stemming, whole-word matching, partial support, titles, hyphens,
  undecodable bytes).
- The three fictional reports in `reports/`, this documentation, and
  `.gitignore`.

## Assisted files

Claude Code wrote or edited: `main.py`, `test_main.py`, `reports/*.txt`,
`README.md`, `AI_USAGE.md`, `.gitignore`, and rendered the two images in
`screenshots/` from real runs of `main.py`.

## What I changed, decided, or verified

Decisions I made during the session:
- Asked for partial matching, tried it, then reverted to requiring all
  keywords on one line because I had misunderstood what partial matching
  would do.
- Reviewed examples of false matches from a broad `-y` stemming rule and chose
  the narrow `-ier(s)` to `-y` rule.
- Required `supply` to return the body line (line 4), not the title, so body
  lines are now preferred over titles.
- Chose fixes 1 (undecodable bytes) and 3 (hyphens) from the weak-point list.
- Declined to change the trailing-"e" stemming rule, so `rat` still matches
  "rate"; this is documented as a limitation, although I believe it is
  preferable to the alternative.

Verification:
- Ran `python3 -m unittest -v` (13 tests, all passing) and the demo after each
  change, including from the final student folder.
- Ran manual queries and about 100 probing queries; these found real bugs that
  were then fixed: `flag` not matching "flagged" (doubled consonant), and a
  file with a bad byte silently hiding later lines.
- One test Claude wrote had a wrong expectation (it assumed `supply
  suppliers` was two keywords); the test, not the code, was corrected.
- Confirmed no credentials or personal data are in the submitted files, and
  that all report data is fictional.

Known weak points I chose to leave are listed under Limitations in the README.
