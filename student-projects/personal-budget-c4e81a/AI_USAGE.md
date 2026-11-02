# AI usage record

## Tool

Claude (Anthropic) in the claude.ai app, used as a coding and writing assistant.
No AI model runs inside the application at runtime.

## Prompts (summary)

1. "Explain the Personal Budget Assistant project and what I need to know, then complete the
project" — together with the course question packet (questions on rule map vs. classifier,
architecture, Google Cloud mapping, spending policy, evaluation, corrections, grounded explanations).
2. The assistant was asked to read the repository README, `CONTRIBUTING.md` and
`docs/PROJECT\_README\_TEMPLATE.md` and follow them.

## Assisted files

All files in this folder were drafted with AI assistance: `budget\_assistant/\*.py`, `tests/\*.py`,
`data/\*`, `README.md`, `docs/DESIGN.md`, this file, and the two screenshots (captured by an
automated browser script against the running app).



## My review and corrections

\- I read the course packet questions and checked the worked examples by hand against the

&#x20; tests: Q4 ($180 + $1,200 + $80 = $1,460; grocery budget 72% used, $70 left),

&#x20; Q5 (precision 80%, recall 90%, accuracy 87%, dollar error $100),

&#x20; Q6 (total stays $130 after moving T2 to Dining), Q7 (repeated import stays $50).

\- I ran the tests on my own Windows computer (`py -m unittest discover -s tests -v`): 40 tests, OK.

\- When I first opened the web app in my browser, the page kept loading and never appeared.

&#x20; The server handled only one connection at a time, and the browser opens an extra idle

&#x20; connection that blocked it. The server was changed to handle connections separately

&#x20; (with a lock so only one request changes the saved data at a time). I restarted the app

&#x20; and confirmed the page loads.

\- I tested the app by hand: loaded the sample file, saw 4 rejected rows with reasons,

&#x20; corrected S012 (LUNA BOOKSHOP) to Shopping and confirmed net spending stayed $1,695.49,

&#x20; then switched to household-b and confirmed it could not see household-a's data.

\- The dropdown in the correction form first showed the wrong category; it was changed to

&#x20; show the transaction's current category.

\- I decided negative amounts should be rejected with a hint to use type=refund, so the app

&#x20; never guesses which direction money moved.

## Verification actually performed

* `python3 -m unittest discover -s tests -v` → **40 tests, OK** (Python 3.13, Linux).
* Ran `python3 -m budget\_assistant report data/sample\_transactions.csv` and compared the
Groceries total ($203.35) and net spending ($1,695.49) with a hand calculation.
* Ran the web app, loaded the sample, corrected S012 → Shopping, confirmed net spending did not change,
uploaded a file without a `description` column and confirmed it was refused.
* Searched the folder for personal names, emails and credentials before submission.

