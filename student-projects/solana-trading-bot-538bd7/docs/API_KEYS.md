# API keys

Everything lives in `.env` at the repository root. That file is git-ignored.
Nothing in it is written to the database, returned by any API route, printed in
a log line, or shown in the dashboard. `GET /api/status` reports whether each
provider is *configured*, never what it is configured with.

## What you need to paste in

Open `.env` and fill these in yourself:

```bash
HELIUS_API_KEY=
LUNARCRUSH_API_KEY=
OPENROUTER_API_KEY=
SOLANA_RPC_URL=https://solana-mainnet.gateway.tatum.io
SOLANA_RPC_API_KEY=
```

## Each provider

### Helius — contract data and wallet tracking
Free tier. Two jobs: the DAS API supplies the mint authority, freeze authority
and metadata the security agent reasons over, and the enhanced-transactions API
supplies parsed swaps for the copy-trade agent.

**Without it the security gate fails closed and refuses every trade**, because a
clean sheet with no data means the checks did not run, not that the token is
safe. Copy trading also cannot see any wallet activity.

Get one at https://helius.dev

### Solana RPC — balances, holders, confirmations
Any Solana RPC works. The default is Tatum's gateway, which wants its key in an
`x-api-key` header rather than in the URL, which is what `SOLANA_RPC_API_KEY`
is for. If your RPC carries the key inside the URL instead, put the whole URL in
`SOLANA_RPC_URL` and leave `SOLANA_RPC_API_KEY` blank.

Used for holder distribution, wallet balances, sending transactions and
confirming them.

### LunarCrush — social and sentiment (optional)
Free tier, rate limited hard, so the agent caches for the interval you set and
paces itself to roughly one call every six seconds.

It aggregates X, Reddit, YouTube, TikTok and news, which is cheaper and far
friendlier to each platform's terms than scraping them separately. **As of
writing, LunarCrush's public v4 endpoints answer HTTP 402 (payment required)
on the free tier**, so a key here currently produces nothing — every call
degrades to null like any other failure. Leave it blank until that changes, or
paste one anyway; it costs nothing to have configured and picks back up
automatically once the endpoint is reachable again.

Get one at https://lunarcrush.com/developers

### News feed — social fallback, no key needed
Always on, regardless of the LunarCrush key. Reads Solana's own developer news
(`solana.com/news`) plus CoinDesk, CoinTelegraph, Decrypt and The Block over
plain RSS, matches headlines against a token's symbol and name, and produces
the same mentions/sentiment shape LunarCrush does — just coarser, since a
headline mention is a weaker signal than a cross-platform aggregator. This is
what the social and sentiment dimensions actually run on today.

`agents.social.getSnapshot` tries LunarCrush first when a key is present and
falls back to this feed on any failure (including the 402 above); after a few
consecutive failures it stops calling LunarCrush for half an hour rather than
spending a round trip on a key that is not going to answer. No setup, no key,
nothing to rotate.

### OpenRouter — plain-language summaries
Optional, and used for exactly one thing: rephrasing a decision the engine has
already made into a sentence a person can read.

It never decides whether to trade, never sees a key, and every failure returns
nothing so the deterministic explanation stands on its own. The default model
is a free one.

Get one at https://openrouter.ai

### DexScreener — prices, liquidity, volume
No key needed. Covers every Solana DEX pair, which is why it is the default
market provider. The client is rate limited well inside its published limits.

### Jupiter — quotes, routing, swaps
No key needed on the lite endpoints. Supplies price quotes and, in live mode,
builds the unsigned swap transaction. It never signs or sends: only the live
executor, which holds the wallet, can do that.

## The wallet

```bash
WALLET_PRIVATE_KEY=
```

Your base58 secret key, the string Phantom exports. **Paper trading never reads
it.** Leave it blank until you actually want to go live.

It is decoded once at startup, held in memory as a keypair, and handed to the
signer through a callback that never returns it, so it cannot be stored or
passed on by the caller. It is never written anywhere.

If the value is not a valid 64-byte base58 secret key the app reports the
problem without ever echoing any part of the value.

## Rotating keys

If a key has been pasted into a chat window, a screenshot, an issue, or
anywhere else public, treat it as public and rotate it. All four providers let
you revoke and reissue from their dashboard.
