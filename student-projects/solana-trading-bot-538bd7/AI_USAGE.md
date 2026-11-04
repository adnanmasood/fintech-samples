# AI usage

## Tool

Claude Code (Anthropic) was used as a coding assistant while building and preparing this
project.

## Prompts

_TO BE COMPLETED BY THE AUTHOR: a summary of the main prompts used to design and build the
application._

Prompts used to prepare this submission, in summary:

- Prepare the project for a pull request to the course repository, in its own folder.
- Follow the course submission rules, and add screenshots.
- Make sure `.env` values are not pushed.
- Lower the max position from $500 to $250 (the author chose this from three options suggested
  by Claude Code).

## Assisted files

- **Application:** project history records Claude as the author of the commits that built the
  platform, including the agents, server, console, landing page and tests. _AUTHOR TO CONFIRM
  and add detail._
- **Submission preparation, written or changed by Claude Code:** `README.md`, `AI_USAGE.md`,
  the five files in `docs/screenshots/`, and `docs/OVERVIEW.md` (the earlier README, moved, with
  corrected links and the Hot Trade interval changed from 5 to 3 minutes to match the code).
  Personal details were removed from `LICENSE` and `site/index.html`, and the interval wording
  was corrected in `site/index.html`. A third-party contact email was removed from a deprecation
  notice in `package-lock.json`.
- **Small modification, implemented by Claude Code:** `apps/server/src/config/defaults.ts`,
  `apps/server/test/portfolio-risk.test.ts` and `docs/CONFIGURATION.md`.

## Author's changes

_TO BE COMPLETED BY THE AUTHOR: what you changed, corrected or decided yourself._

## Verification

Actually run for this submission:

- `npm ci`, `npm run migrate`, `npm run build` and `npm start` in a separate clean copy, with
  no API keys and no wallet.
- `npm test`: 117 of 117 tests passed across 10 files. `npm run typecheck`: no errors.
- The new position cap tests were run against the old $500 value first, and two failed as
  expected. They passed after the change.
- A paper-mode scan, an invalid wallet key and a refused switch to live mode, with the observed
  results recorded in `README.md`.
- Each screenshot was inspected for personal data and secrets.
- `python scripts/check-publication.py` from the course repository root. On Windows it passed only
  with a temporary path-separator fix kept outside the repository, because the unmodified script
  reports false errors under `fintech-algorithms` there.
- A search of every staged file for the real local configuration values, which found none.

Live trading with a real wallet was not tested for this submission.
