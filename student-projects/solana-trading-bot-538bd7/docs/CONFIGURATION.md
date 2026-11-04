# Configuration

Every tunable parameter lives in one validated document. Nothing in the trading
logic is hard-coded: strategies read the live config on every run, so a change
takes effect on the next cycle without a restart.

- **Where it lives:** one row in the `settings` table.
- **How to change it:** the Settings page, or `PATCH /api/config`.
- **Validation:** the whole document is re-validated on every write. An invalid
  patch is rejected and the running config is untouched.
- **History:** every accepted change is appended to `settings_history` with a
  version number, so a bad edit can be traced.

Secrets are **not** part of this document. Keys and the wallet come from the
environment only, which is why the config is safe to serve to the browser in
full.

## Mode

```
mode: 'paper' | 'live'
```

Setting this to live is necessary but not sufficient. The environment must also
carry `LIVE_TRADING_CONFIRMED`. `effectiveMode()` is what the rest of the system
asks, and it returns paper unless both agree.

## Portfolio

| Key | Default | Meaning |
|---|---|---|
| `paperStartingBalanceUsd` | 10000 | Starting equity for paper mode |
| `allocations` | 30/30/25/15 | Bucket split, must total 100 |
| `cashBufferPct` | 10 | Share of each bucket kept in cash so exits are never blocked |
| `markToMarketSec` | 60 | How often positions are re-marked and stops checked |

## Risk

| Key | Default | Meaning |
|---|---|---|
| `maxPositionPctOfBucket` | 20 | Largest position as a share of its bucket |
| `maxPositionUsd` | 500 | Hard ceiling on one trade |
| `minPositionUsd` | 10 | Below this a trade is not worth making |
| `maxBucketExposurePct` | 80 | Most of a bucket that may be invested at once |
| `maxTotalExposurePct` | 70 | Most of the portfolio that may be invested at once |
| `maxDailyLossPct` | 10 | Trading halts for the day past this |
| `maxOpenPositions` | 20 | Across everything |
| `maxOpenPositionsPerBucket` | 6 | |
| `maxLossPerTradePct` | 25 | Hard ceiling on one trade's loss, whatever the stop said |
| `stopLossPct` | 15 | |
| `takeProfitPct` | 40 | |
| `trailingStopPct` | 0 | Percent below the high water mark. Zero disables it |
| `maxSlippageBps` | 150 | |
| `minLiquidityUsd` | 25000 | |
| `maxPoolShareBps` | 100 | A trade may take at most 1% of the pool |
| `maxTokenConcentrationPct` | 15 | One token's ceiling across the whole portfolio |
| `duplicateTradeCooldownSec` | 900 | Same agent, same token, same side |
| `maxTradesPerAgentPerHour` | 12 | |
| `minSecurityScore` | 60 | |
| `killSwitch` | false | Stops new positions. Never blocks an exit |

Most of these **shrink** a trade rather than refusing it. A signal is only
rejected outright when the allowed size falls below `minPositionUsd`.

## Security

| Key | Default | Meaning |
|---|---|---|
| `rejectAtSeverity` | high | Any flag at or above this rejects the token |
| `minLiquidityUsd` | 15000 | |
| `minTokenAgeMinutes` | 30 | |
| `maxTopHolderPct` | 25 | Largest single wallet |
| `maxTop10HolderPct` | 55 | |
| `maxBuyTaxBps` / `maxSellTaxBps` | 500 | 5% each |
| `minLpLockedFraction` | 0 | Raise it if your provider reports lock state |
| `requireMintAuthorityRevoked` | true | A live mint authority is critical |
| `requireFreezeAuthorityRevoked` | true | A live freeze authority is critical |
| `maxVolumeToLiquidityRatio` | 40 | Above this, volume looks washed |
| `maxBuySellImbalance` | 12 | Above this, activity looks automated |
| `cacheTtlSec` | 600 | How long a passing assessment is reused |
| `failClosed` | true | **Leave this on.** No data means no trade |

## Execution

| Key | Default | Meaning |
|---|---|---|
| `takerFeeBps` | 30 | Venue fee, used by the paper executor |
| `networkFeeUsd` | 0.02 | Flat per-transaction cost |
| `paperBaseSlippageBps` | 30 | Floor slippage in simulation |
| `paperImpactBpsPerPoolPct` | 60 | Extra slippage per percent of pool consumed |
| `liveMaxRetries` | 1 | A timeout is never retried |
| `liveConfirmTimeoutSec` | 60 | |
| `quoteMint` | wSOL | Quote asset for pricing and swaps |

## Agents

Each agent has `enabled`, `intervalSec`, `minScore`, `minConfidence`,
`maxTradeUsd`, `maxOpenPositions` and its own `weights` map, plus its own
screening thresholds.

### Scoring weights

Ten dimensions per agent, and they must total 1.0:

```
security  liquidity  momentum  volume  smartMoney
holderGrowth  social  sentiment  marketCap  trader
```

The defaults follow the house weights, then each agent deviates where its
thesis demands it. Copy Trade gives real weight to `trader`, because a copied
trade lives or dies on the leader's record. Hot Trade leans on `momentum` and
`volume`. Small Market Cap pushes `security` to 30% and `liquidity` to 20%,
because small caps die of thin liquidity and bad contracts far more often than
they die of weak momentum.

### Per-agent screens

| Agent | Notable thresholds |
|---|---|
| `copy_trade` | `intervalSec` 900, `followedWallets`, `minTraderScore` 65, `copyRatio` 0.05, `mirrorExits` true |
| `hidden_gem` | market cap 100k to 10M, `minVolumeGrowthPct` 40, age 12h to 120d |
| `hot_trade` | `intervalSec` 300, `minVolumeSpikeMultiple` 2.5, `maxChaseGainPct` 60 |
| `small_market_cap` | market cap 50k to 2M, `maxWalletConcentrationPct` 40, own `minSecurityScore` 75 |
| `social` | `minMentions24h` 25, `spikeMultiple` 3, `maxSpamRatio` 0.5 |

`copy_trade.followedWallets` starts empty. Add the wallets you want to follow
in the config; the agent rates each one before it copies anything.

## Discovery

| Key | Default |
|---|---|
| `maxTokensPerScan` | 60 |
| `searchTerms` | SOL, USDC, BONK, WIF, JUP |
| `minLiquidityUsd` | 20000 |

## Lists

`lists.blacklist` and `lists.whitelist` are seeded into the database at
startup. The security agent can add to the blacklist itself when it catches a
critical flaw, and those additions survive a restart.
