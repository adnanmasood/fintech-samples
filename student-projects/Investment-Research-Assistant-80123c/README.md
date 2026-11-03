# Investment Research Assistant: Retrieval Component

## Financial use case

The retrieval component of an Investment Research Assistant agent for the
fictional firm Verity Research Systems. An analyst (or the agent acting for
one) asks a question as a few keywords, for example `interest-rate hedge`. The
component searches three fictional local research reports and returns the
matching excerpt with its **filename and line number**, so every claim can be
traced to a source line. When no passage supports the query it returns
`NOT_FOUND` instead of guessing.

- **Input:** a keyword query (command-line argument or `main.search(query)`).
- **Output:** `filename:line: excerpt`, or `NOT_FOUND`.
- No LLM and no vector database are used.

## Run and test

Prerequisites: Python 3. Tested with Python 3.14.7. **No third-party
dependencies and nothing to install** (standard library only), so there is
nothing to pin. No configuration or environment variables are needed.

Run all commands from this folder:

    python3 main.py                        # built-in demo
    python3 main.py "interest rate hedge"  # your own query
    python3 -m unittest -v                 # tests

From Python (for the agent):

    import main
    main.search("supply")    # "supply_chain.txt:4: Two suppliers were ..." or "NOT_FOUND"
    main.retrieve("supply")  # {"file": ..., "line": ..., "excerpt": ...} or None

## Demonstration

**Normal case:** input `interest-rate hedge`.
Expected: the line about interest rate hedges. Observed:
`risk_outlook.txt:4: Interest rate hedges cover 60% of floating debt.`
(see [screenshots/normal-run.png](screenshots/normal-run.png)).
Hyphens split words and `hedge` matches `hedges`, so the hyphenated query finds the line.

**Failure case:** input `lithium bitcoin`.
Expected: `NOT_FOUND`, because no report line mentions both. Observed:
`NOT_FOUND` (see [screenshots/failure-run.png](screenshots/failure-run.png)).
`bitcoin` alone and an empty query also return `NOT_FOUND`.

**Business rule explained:** a line counts as evidence only if it contains
**all** of the query's keywords. A partial match is not evidence, so the
component says `NOT_FOUND` rather than returning a loosely related line. This
is how it handles missing or conflicting evidence: if the support is not on
one line, nothing is returned. (An earlier version returned partial matches;
I reverted it because I had misunderstood what partial matching would do.)

Other matching rules: case-insensitive whole words, common words (`the`, `of`)
ignored, light stemming (`hedge`/`hedges`, `flag`/`flagged`,
`supply`/`suppliers`), and files with undecodable bytes are still searched.

## Verification and modification

Actual test result (`python3 -m unittest`, Python 3.14.7):

    Ran 13 tests in 0.006s
    OK

The tests cover normal queries, `NOT_FOUND` failures (no evidence, empty,
stopword-only, `None`, partial support), stemming, whole-word matching,
hyphens, and a file containing a bad byte.

**One small modification I made:** `supply` originally returned the report
*title* (`supply_chain.txt:1: Supply Chain Review`) instead of the sentence
with evidence. I changed the search to prefer body lines over a file's title
(line 1), falling back to the title only if no body line matches. Why: a title
is a heading, not supporting evidence. Checks: `test_supply_matches_supplier`
asserts `supply` returns `supply_chain.txt:4`, and
`test_title_used_only_as_fallback` asserts `supply chain review` still returns
the title line.

## Limits and AI assistance

Limitations:

- **A keyword match is not proof.** `cybersecurity critical issues` returns
  "...found no critical issues": the words match but the meaning is the
  opposite. The agent must read the excerpt.
- First matching line only (filename order), not a ranked list.
- No synonyms or word families: `growth`/`grew`, `supplies`/`supply`,
  `delay`/`late`, `stable`/`flat`, `utilisation`/`utilization`,
  `60 percent`/`60%` do not match each other.
- Question-style queries (`did revenue grow`) usually return `NOT_FOUND`; use
  short keywords.
- The stemmer can over-match: dropping a trailing "e" means `rat` matches
  "rate". Known and accepted.
- Only `*.txt` files directly in `reports/`; English/ASCII text only.

Mocks: none. There are no network calls, APIs, LLM or database to mock. Tests
use the real sample reports and small temporary files.

AI assistance: Claude Code built and iterated on the code, tests and docs. See
[AI_USAGE.md](AI_USAGE.md) for prompts, assisted files, my decisions and
corrections, and the verification I ran.

## Data

All data is fictional. `reports/q3_revenue.txt`, `reports/risk_outlook.txt` and
`reports/supply_chain.txt` are short made-up research notes (company names
such as "Acme Widgets" are invented). Each file is plain text:
line 1 is a title, and each following line is one sentence of the report.
Line numbers in results are 1-based and refer to these files. There are no
secrets, names, contact details, IDs, grades or real financial records.
