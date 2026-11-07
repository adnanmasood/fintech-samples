# Runbook

## Starting it

```bash
npm install
cp .env.example .env
npm run migrate
npm run dev
```

`npm run dev` serves everything on **port 8787**: the API, the landing page at
`/` and the console at `/app/`. The console is rebuilt as you edit it. There is
no second port.

If you want Vite's hot module reload while working on the console's own
styling, `npm run dev:hmr` puts it on 5173 instead, still proxying the API.

For a single built process, `npm run build && npm start`.

## "It still shows the old version"

Check what is actually running before changing anything:

```bash
curl http://127.0.0.1:8787/api/health
```

It reports `appVersion`. The console shows the same thing at the bottom of the
sidebar, and the landing page prints it in the footer. If that number is not
what you expect, work down this list:

1. **Did the pull land?** `git log --oneline -1` should match the newest commit
   on the branch. If it does not, the pull failed, and nothing else matters.
2. **Rebuild.** `npm run build`. If you are running `npm start`, it serves a
   built bundle, and the bundle does not rebuild itself.
3. **Restart the server.** An old process may still be holding port 8787.
   On Windows: `netstat -ano | findstr :8787`, then `taskkill /PID <pid> /F`.
4. **Hard refresh the browser.** Ctrl+Shift+R on Windows, Cmd+Shift+R on a Mac.

The server sends `no-cache` on the HTML, the stylesheet and the script, so a
stale page should not survive a normal reload. Media is cached hard on purpose:
those filenames are stable and their contents never change.

## Checking it is healthy

```bash
curl http://127.0.0.1:8787/api/status | jq
```

The important fields:

- `appVersion` — the build that is running.
- `mode` — what it is *actually* doing. Compare against `configuredMode`.
- `liveReady` and `liveBlockers` — exactly what is stopping live trading.
- `providers[]` — which are configured. Add `?probe=true` to also test reachability.
- `scheduler[]` — last run, next run, and `skippedCount` per job.

## "Nothing is trading"

This is usually correct behaviour. Work down the list:

1. **Is the kill switch on?** `status.killSwitch`.
2. **Is Helius configured?** Without it the security gate fails closed and
   refuses everything. This is the most common cause.
3. **Check the decision log.** Filter by `security` and by `risk`. Every
   refusal is there with its reason.
4. **Look at the agent panel.** High `rejected` counts with zero signals means
   the screens are doing their job. Most cycles produce nothing.
5. **Daily loss limit.** Once breached, trading halts until the next UTC day.
6. **Thresholds.** `minScore` and `minConfidence` are deliberately strict.
   Lower them in Settings if you want more activity, and expect worse trades.

## Seeing what it is actually doing

The **Activity** tab is the live feed: every provider call with its status and
timing, and every log line, in order. Open it and press Scan now on the Agents
tab to watch a whole cycle happen.

What to look for:

- **403 or 401 on a provider** means the key is missing or wrong. The panel
  names the provider.
- **429** means a rate limit. Raise that agent's `intervalSec`.
- **A provider with zero calls** is not configured at all.
- **`cached`** in the status column means the answer came from the client's own
  cache and cost nothing.

Query strings are stripped before anything is recorded, because several
providers carry their key there and this feed is served to the browser.

## "An agent keeps failing"

The agent panel shows `lastError`. A failing agent is contained: it reports an
empty run rather than taking the scheduler or the other agents down. Common
causes are a provider rate limit or a network blip, both of which resolve on
the next cycle.

## "Runs are being skipped"

`skippedCount` rising means a scan is taking longer than its interval. The
scheduler refuses to overlap a job with itself, so it skips rather than queues:
a queue of stale scans is worse than a missed one. Either raise `intervalSec`
or lower `maxTokensPerScan`.

## Going live

1. Set all three in `.env`: `TRADING_MODE=live`,
   `LIVE_TRADING_CONFIRMED=I_UNDERSTAND_LIVE_TRADING_RISK`, and
   `WALLET_PRIVATE_KEY`.
2. Restart.
3. `curl .../api/status` and confirm `liveReady: true` with an empty
   `liveBlockers`.
4. Switch the mode in Settings.
5. Start small. Lower `maxPositionUsd` for the first day.

If `liveBlockers` is not empty, the system stays on paper and tells you which
switch is missing.

## Something is going wrong right now

- **Kill switch** stops all new positions immediately. It does not sell.
- **Close all** exits every position at the current mark. Exits are never
  blocked by a risk limit or the kill switch.

Both are in the console header and both are also API routes.

## A live trade did not confirm

Check `GET /api/transactions`. Every submission is recorded with its status:
`submitted`, `confirmed`, `failed` or `timeout`.

A `timeout` is deliberately **not** retried, because the original transaction
may still land and a second send could buy the same thing twice. No position is
opened for an unconfirmed transaction, so if the first one does land, the
position will be missing from the books. Reconcile by checking the signature on
a block explorer.

## The database

SQLite at `data/usf.db`. To reset paper trading completely:

```bash
rm -rf data/ && npm run migrate
```

The decision log self-prunes after 30 days and the token cache after 14, so a
long run does not grow without bound.

## Tests

```bash
npm test
```

106 tests covering scoring, security rules and the gate, risk limits, bucket
maths, paper execution, the live abstraction, the scheduler's overlap lock,
trader scoring, config validation, the activity feed's redaction, and the full
pipeline from discovery to a booked trade. They run against an in-memory database with static providers, so
they need no network and no keys.
