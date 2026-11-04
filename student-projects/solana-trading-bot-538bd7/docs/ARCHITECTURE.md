# Architecture

## The one rule

Agents produce signals. They cannot execute.

Nothing in `src/agents/` imports the execution service, the wallet, or a DEX
provider. An agent's entire output is an array of `TradeSignal` objects handed
back to the scheduler, which passes them to the signal engine. That is the only
path to a trade, and there is no way around it.

This is what makes a new strategy cheap: adding one cannot introduce a new way
to spend money, so it needs no re-audit of the money path.

## The pipeline

```
                 ┌──────────────────────────────────────────┐
                 │  Market data (DexScreener, Helius)       │
                 └───────────────────┬──────────────────────┘
                                     │
      ┌──────────┬───────────────────┼──────────────┬─────────────┐
      │          │                   │              │             │
 Copy Trade  Hidden Gem         Hot Trade    Small Market Cap   Social
      │          │                   │              │             │
      └──────────┴─────────┬─────────┴──────────────┘             │
                           │  signals                    scores ◄─┘
                           ▼
                    ┌─────────────┐
                    │ Signal      │
                    │ Engine      │
                    └──────┬──────┘
                           ▼
                   ┌───────────────┐   reject
                   │ Security      ├──────────►  logged, stops here
                   │ (hard gate)   │
                   └───────┬───────┘
                           ▼
                   ┌───────────────┐   reject or shrink
                   │ Risk Manager  ├──────────►  logged, stops here
                   └───────┬───────┘
                           ▼
                   ┌───────────────┐   no cash
                   │ Portfolio     ├──────────►  logged, stops here
                   └───────┬───────┘
                           ▼
                   ┌───────────────┐
                   │ Execution     │
                   │ Service       │
                   └───┬───────┬───┘
                       │       │
                 Paper │       │ Live
              Executor ▼       ▼ Executor
                  simulated    Jupiter → sign → send → CONFIRM
```

Every arrow that stops writes a row to `system_events` with the numbers that
caused it. The dashboard's decision log is a view over that table.

## Layers

| Directory | Responsibility | May import |
|---|---|---|
| `core/` | Domain types, money, clock, errors | nothing |
| `config/` | Schema, defaults, the live config service | core, db |
| `db/` | Drizzle schema, client, migrations | core |
| `providers/` | Every outside dependency, behind an interface | core |
| `market/` | Token storage, history, discovery | core, db, providers |
| `security/` | Rules, lists, the gate | core, db, providers, config |
| `scoring/` | Dimensions and the weighted engine | core, db, config |
| `agents/` | Strategy. Emits signals only | everything above |
| `risk/` | The veto and the sizing | core, db, config, portfolio |
| `portfolio/` | Buckets, cash, positions, P&L | core, db, config |
| `execution/` | Paper and live executors, bookkeeping | core, db, providers, wallet |
| `signals/` | The pipeline that ties it together | everything |
| `scheduler/` | Interval jobs with overlap locks | core |
| `http/` | REST API | everything |

`app.ts` is the composition root. Every dependency is constructed there and
passed in, so the whole system can be built in a test with a fake clock, an
in-memory database and static providers, and no network at all.

## Provider independence

Every outside dependency sits behind an interface in
`providers/interfaces.ts`:

```
MarketDataProvider   TokenSecurityProvider   BlockchainProvider
DexProvider          SocialDataProvider      TradeExecutor        LlmProvider
```

Nothing above the provider layer imports a vendor SDK or knows a vendor's URL.
Swapping DexScreener for Birdeye is a new file in `providers/market/` and one
line in `registry.ts`.

Every provider must answer `isConfigured()` honestly. A missing key wires a
null provider rather than leaving something undefined, and the security gate
reads that flag to decide whether to fail closed.

## The security gate

Three ways to be refused, and none of them can be outscored:

1. On the blacklist.
2. Carrying a flag at or above the configured reject severity.
3. No security provider reachable, with `failClosed` on.

A whitelist can soften a rules-based rejection, because a user vouching for a
token is a deliberate act. It cannot soften a **critical** flag: those are the
ones that take your money, and no amount of vouching changes that.

When the agent catches a permanent contract flaw it adds the token to the
blacklist itself, so the same provider call is not paid for twice.

## Explainability

Every score carries its components, each with a weight and a plain sentence.
Every score also carries `dataCoverage`, the share of the weighted total that
came from real rather than neutral data, and agent confidence leans on it
heavily. A perfect score with half its dimensions missing should not clear a
confidence gate that a merely good score with full data would.

## Money

USD amounts are numbers rounded to cents through `roundUsd()` before every
write, so a long paper run cannot drift the books through repeated float
arithmetic. Exposure is always measured at cost basis, never at mark, so an
unrealised gain cannot inflate the room to open more risk.

## Time

Every timestamp goes through the `Clock` seam. Tests use `FakeClock`, which is
why the scheduler, cooldowns and daily-loss windows can be tested without
sleeping.
