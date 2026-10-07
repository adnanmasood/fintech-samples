# AI Usage Notes

This assignment was completed with the assistance of Claude Code
(Anthropic), an AI coding assistant, in a chat-based CLI workflow.

## What the AI was used for

- Generating the initial implementation of `main.py`, including the
  `Transaction`/`Decision` data classes, the mock risk-scoring function,
  and the threshold-based decision engine.
- Generating the `unittest` test suite in `test_main.py`, covering
  threshold boundaries, the mock scorer, and end-to-end behavior.
- Writing this `README.md` and the project `.gitignore`.
- Running `python3 main.py` and `python3 -m unittest -v` to verify the
  code executes correctly and all tests pass.

## What was reviewed/verified by the student

- Confirmed the decision thresholds match the assignment spec exactly:
  APPROVE below 0.30, CHALLENGE from 0.30 through 0.69, DECLINE at 0.70
  or above, and CHALLENGE as the fallback when a score is missing.
- Confirmed the mock risk score is generated independently from the
  decision rules (two separate functions), so scoring and policy are
  not tangled together.
- Confirmed all sample data (transaction IDs, card numbers, merchants,
  amounts) is clearly fictional.
- Verified the demo output and test results locally before submission.

## Disclosure

This is a toy/educational demo built for a USF Fintech course
assignment. It uses only the Python standard library, contains no real
transaction or cardholder data, and is not intended to represent a
production fraud-detection system.
