# USF Solana Trading Bot

A multi-agent trading platform for Solana. Six independent agents discover,
score and screen tokens; a central engine turns their signals into trades; and
any one of the gates along the way can stop a trade the others liked.

It defaults to paper trading and stays there until you deliberately switch it
over with two separate, independent switches.

```
Agent → Signal Engine → Security → Risk Manager → Portfolio → Execution → Database
```

Agents produce signals. They cannot execute, cannot reach the wallet, and
cannot move value. That separation is the whole point of the architecture.

---

## Quick start

```bash
git clone https://github.com/adnanmasood/fintech-samples.git
cd fintech-samples/student-projects/solana-trading-bot-538bd7

npm install
cp .env.example .env      # then fill it in, see below
npm run migrate
npm run build
npm start
```

Then open:

| Page | Address |
|---|---|
| Landing page | http://127.0.0.1:8787/ |
| Trading console | http://127.0.0.1:8787/app/ |
| API | http://127.0.0.1:8787/api/status |

To confirm which build is running: `curl http://127.0.0.1:8787/api/health`. The
console shows the same version at the bottom of its sidebar.

For development, with the server reloading and the console rebuilding as you
edit:

```bash
npm run dev
```

**Everything is on port 8787.** The console is served by the API server, so
there is no second port to remember. (`npm run dev:hmr` runs Vite's hot-reload
server on 5173 instead, if you are working on the console's own styling and
want instant refresh.)

Requires Node 20.11 or newer.

---

## Your API keys

Everything goes in `.env`, which git ignores. Nothing in that file is ever
written to the database, returned by the API, printed in a log, or shown on
screen.

**You need to paste these in yourself.** Open `.env` and fill in:

```bash
HELIUS_API_KEY=            # your Helius key
LUNARCRUSH_API_KEY=        # your LunarCrush key
OPENROUTER_API_KEY=        # your OpenRouter key
SOLANA_RPC_URL=https://solana-mainnet.gateway.tatum.io/
SOLANA_RPC_API_KEY=        # Tatum wants its key in a header, so put it here
```

Tatum's gateway takes its key in an `x-api-key` header rather than in the URL,
which is why it has its own field. Check it works with:

```bash
curl --request POST --url 'https://solana-mainnet.gateway.tatum.io/' \
  --header 'content-type: application/json' \
  --header 'x-api-key: YOUR_TATUM_KEY' \
  --data '{"id":1,"jsonrpc":"2.0","method":"getBlockHeight"}'
```

`API_KEYS.md` explains what each one does, what breaks without it, and
which are optional. The short version:

| Key | Needed for | Without it |
|---|---|---|
| Helius | Contract checks, holder distribution, wallet tracking | The security gate fails closed and refuses every trade. Copy trading cannot see any wallets. |
| LunarCrush | Social and sentiment scores | Those two dimensions score neutral and are marked as having no data. |
| OpenRouter | Plain-language trade summaries | Decisions still get their full deterministic explanation. |
| DexScreener | Prices, liquidity, volume | Needs no key. |
| Jupiter | Quotes, routing, live swaps | Needs no key. |

If you pasted a key into a chat window or anywhere else public, rotate it.

### The wallet

Paper trading never touches a wallet and never reads `WALLET_PRIVATE_KEY`.

For live trading, put your base58 secret key (the string Phantom exports) in
`WALLET_PRIVATE_KEY`. It is decoded once, held in memory, and used only to
sign. It is never persisted or logged.

---

## Going live

Live trading needs a configured wallet. Nothing else is required:

1. In `.env`:
   ```bash
   WALLET_PRIVATE_KEY=your_base58_key
   ```
   Restart once so the key is picked up.
2. In the console (the top corner button, or Overview), switch the mode to
   live. This takes effect immediately, no further restart needed.

`GET /api/status` reports `liveReady` and lists exactly what is still blocking
it. If anything is missing, the system runs on paper and says so rather than
failing quietly.

A live trade is not reported as filled until the transaction is confirmed on
chain. A submitted-but-unconfirmed send opens no position.

---

## The four buckets

The wallet is one wallet. It is divided into four logical budgets that cannot
borrow from each other.

| Bucket | Default | Fed by |
|---|---|---|
| Copy Trading | 30% | Copy Trade Agent |
| Hot Trading | 30% | Hot Trade Agent, every 3 minutes |
| Hidden Gems | 25% | Hidden Gem Agent |
| Low Market Cap | 15% | Small Market Cap Agent |

Change the split in the console. It refuses anything that does not total 100,
and only uninvested cash is redistributed: open positions keep the bucket they
were opened in, because rebalancing them would mean selling into the market on
a settings change.

---

## The agents

Five scheduled agents, plus a security gate that is not on a schedule because
it runs before every single trade.

| # | Agent | What it does |
|---|---|---|
| 1 | Copy Trade | Tracks wallets, rates them on win rate, average return, drawdown and consistency, and flags timing that looks automated. Scans every 15 minutes. |
| 2 | Hidden Gem | Small caps with growing holders and growing volume that the market has not repriced. Explains every pick. |
| 3 | Hot Trade | Runs every 3 minutes. Volume spikes measured against the token's own baseline. Refuses to chase. |
| 4 | Small Market Cap | The strictest. Will not trade a token whose holder distribution it cannot see. |
| 5 | Social Intelligence | Mentions, sentiment, trend, source quality and a spam score to stop bought hype reading as demand. Scores tokens for the others and never trades. |
| — | Token Security | The hard gate. Not scheduled: it runs before every trade, and again inside the pipeline. Holds the blacklist and has a veto over all five. |

The three-minute interval starts a *scan*, not a trade. Most cycles produce
nothing, and that is the system working correctly.

---

## Safety

- **Paper by default**, and live needs both switches above.
- **Security is a gate, not a score.** A critical contract flag is refused no
  matter how good the rest of the numbers look.
- **Fails closed in live mode, always.** No security provider reachable means
  no trade, not an assumption of safety - a config mistake can never change
  this. Paper mode defaults to degrading instead (a score penalty, not a
  refusal) so the pipeline stays observable while a provider is being wired
  up; `security.failClosed` switches that back to refuse-on-missing-data if
  you want paper to match live exactly.
- **The risk manager can veto anything** from any agent, and shrinks an
  oversized trade rather than refusing it.
- **Kill switch** stops new positions instantly. It deliberately does not
  force-sell: a panic button that dumps into a thin market can cost more than
  the thing it was pressed for.
- **Exits are never blocked** by any risk limit or the kill switch.
- **Duplicate protection and rate limiting** per agent.
- **Secrets never leave the environment.** The API reports which providers are
  configured, never their values.

---

## Commands

```bash
npm run dev          # server and dashboard, both with reload
npm run build        # build both
npm start            # run the built server
npm test             # the whole test suite
npm run typecheck    # types across both packages
npm run migrate      # apply database migrations
```

---

## The landing page

`site/` is a scroll-scrubbed cinematic page, plain HTML and CSS and vanilla
JavaScript with no build step. The server serves it at `/`.

The hero video ships with the repository, in two encodes so every browser gets
one: H.264 for hardware decoding, VP9 for builds without the proprietary
codecs. Both carry a keyframe every eight frames, which is what makes
scrubbing smooth rather than steppy.

Phones, short landscape screens and anyone with reduced motion turned on get a
designed still hero instead. That is a deliberate state, not a fallback for
failure, and the page is complete in it.

---

## Documentation

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — the layers and why they are separated
- [`CONFIGURATION.md`](CONFIGURATION.md) — every tunable parameter
- [`API_KEYS.md`](API_KEYS.md) — what each provider does
- [`RUNBOOK.md`](RUNBOOK.md) — running it, and what to do when something misbehaves

## Watching it work

The console has two logs, and they answer different questions.

**Decision log** is the durable record: every accepted and refused trade, with
the scores, security flags and risk checks that caused it. It answers *why did
that happen*.

**Activity** is the live feed: every outbound provider call with its status and
timing, and every application log line, interleaved in order. It answers *what
is it doing right now*, and it is the fastest way to spot a rate limit, a dead
endpoint, or a key that is not being picked up.

---

## A word about risk

This is a personal research project, not financial advice and not an
invitation to invest. Automated trading can lose money quickly, and small-cap
crypto tokens can lose all of it. The defaults are conservative and the mode is
paper for a reason. Run it on paper until you understand exactly what it does.

MIT licensed.
