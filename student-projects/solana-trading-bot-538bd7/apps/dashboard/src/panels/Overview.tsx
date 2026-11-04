import {
  AGENT_LABELS, BUCKET_LABELS, allAgentsPatch, type AgentRow, type ConfigResponse, type Portfolio,
  type PositionRow, type Status, type TradeSummary, type Wallet,
} from '../api';
import { Card, Empty, Money, Pct, Stat, ago, price, shorten, usd } from '../ui';

export function Overview({
  portfolio, positions, status, summary, config, agents, wallet, onMode, onPatch, onRefreshWallet,
}: {
  portfolio: Portfolio | null;
  positions: PositionRow[];
  status: Status | null;
  summary: TradeSummary | null;
  config: ConfigResponse | null;
  agents: AgentRow[];
  wallet: Wallet | null;
  onMode: (mode: 'paper' | 'live') => void;
  onPatch: (patch: unknown) => void;
  onRefreshWallet: () => void;
}) {
  if (!portfolio) return <Empty>Loading the portfolio…</Empty>;

  const dailyPct =
    portfolio.totalValueUsd - portfolio.dailyPnlUsd !== 0
      ? (portfolio.dailyPnlUsd / (portfolio.totalValueUsd - portfolio.dailyPnlUsd)) * 100
      : 0;

  return (
    <>
      {portfolio.mode === 'live' && wallet?.configured && (
        <div className="section">
          <LiveWalletCard wallet={wallet} onRefresh={onRefreshWallet} />
        </div>
      )}

      <div className="section grid k4">
        <Stat
          label="Total portfolio"
          value={usd(portfolio.totalValueUsd)}
          sub={`${portfolio.openPositions} open position${portfolio.openPositions === 1 ? '' : 's'}`}
        />
        <Stat
          label="Total profit and loss"
          value={<Money value={portfolio.realizedPnlUsd + portfolio.unrealizedPnlUsd} />}
          sub={`${usd(portfolio.realizedPnlUsd)} realised, ${usd(portfolio.unrealizedPnlUsd)} on paper`}
        />
        <Stat
          label="Today"
          value={<Money value={portfolio.dailyPnlUsd} />}
          sub={<Pct value={dailyPct} />}
        />
        <Stat
          label="Available cash"
          value={usd(portfolio.spendableUsd)}
          sub={
            portfolio.reservedUsd > 0.01
              ? `${usd(portfolio.reservedUsd)} held back as a buffer · ${usd(portfolio.investedUsd)} invested`
              : `${usd(portfolio.investedUsd)} invested, drawdown ${portfolio.drawdownPct.toFixed(1)}%`
          }
        />
      </div>

      {config && (
        <div className="section">
          <ModeCard data={config} status={status} onMode={onMode} />
        </div>
      )}

      <div className="section grid k2">
        <Card title="Open positions">
          {positions.length === 0 ? (
            <Empty>Nothing is open. The agents only trade when everything lines up.</Empty>
          ) : (
            <div className="scroll-x">
              <table>
                <thead>
                  <tr>
                    <th>Token</th><th>Bucket</th>
                    <th className="num">Entry</th><th className="num">Mark</th><th className="num">P&amp;L</th>
                  </tr>
                </thead>
                <tbody>
                  {positions.map((position) => (
                    <tr key={position.id}>
                      <td>
                        <b>{position.tokenSymbol || shorten(position.tokenAddress)}</b>
                        <div className="faint mono" style={{ fontSize: 10.5 }}>{ago(position.openedAt)}</div>
                      </td>
                      <td className="dim">{BUCKET_LABELS[position.bucket]}</td>
                      <td className="num dim">{price(position.avgEntryPriceUsd)}</td>
                      <td className="num">{price(position.markPriceUsd)}</td>
                      <td className="num">
                        <Money value={position.unrealizedPnlUsd} />
                        <div style={{ fontSize: 10.5 }}><Pct value={position.unrealizedPnlPct} /></div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card title="Trading record">
          {!summary || summary.totalTrades === 0 ? (
            <Empty>No trades yet.</Empty>
          ) : (
            <div className="grid k2" style={{ gap: 10 }}>
              <Field label="Trades" value={String(summary.totalTrades)} />
              <Field
                label="Win rate"
                value={summary.winRate == null ? '—' : `${(summary.winRate * 100).toFixed(0)}%`}
              />
              <Field label="Realised" value={<Money value={summary.realizedPnlUsd} />} />
              <Field label="Fees paid" value={usd(summary.feesUsd)} />
              <Field
                label="Profit factor"
                value={summary.profitFactor == null ? '—' : summary.profitFactor.toFixed(2)}
              />
              <Field label="Closed" value={`${summary.closedWins}W / ${summary.closedLosses}L`} />
            </div>
          )}
        </Card>
      </div>

      <div className="section">
        <Card title="The four buckets">
          {portfolio.buckets.map((bucket) => {
            const pnl = bucket.realizedPnlUsd + bucket.unrealizedPnlUsd;
            const used = bucket.allocatedUsd > 0 ? (bucket.investedUsd / bucket.allocatedUsd) * 100 : 0;
            return (
              <div className="bucket-row" key={bucket.bucket}>
                <div className="bucket-name">
                  <b>{BUCKET_LABELS[bucket.bucket]}</b>
                  <span className="faint mono" style={{ fontSize: 11 }}>
                    {bucket.allocationPct}% target · {bucket.openPositions} open
                  </span>
                </div>
                <div style={{ width: 130 }}>
                  <div className="bar">
                    <i style={{ width: `${Math.min(100, used)}%`, background: 'var(--cyan)' }} />
                  </div>
                  <div className="faint mono" style={{ fontSize: 10.5, marginTop: 4 }}>
                    {used.toFixed(0)}% deployed
                  </div>
                </div>
                <div className="num" style={{ width: 100 }}>{usd(bucket.allocatedUsd)}</div>
                <div className="num" style={{ width: 90 }}>{usd(bucket.spendableUsd)}</div>
                <div className="num" style={{ width: 90 }}><Money value={pnl} /></div>
              </div>
            );
          })}
        </Card>
      </div>

      {status && (
        <div className="section">
          <Card title="Data providers">
            <div className="row">
              {status.providers.map((provider) => (
                <span key={provider.role} className={`tag ${provider.configured ? 'ok' : ''}`}>
                  {provider.role}: {provider.configured ? provider.name : 'not configured'}
                </span>
              ))}
              <span className="tag">{status.tokensTracked} tokens tracked</span>
            </div>
          </Card>
        </div>
      )}

      <div className="section">
        <AgentSwitch agents={agents} onPatch={onPatch} />
      </div>
    </>
  );
}

/**
 * What the chain says the wallet holds, right now. Live mode only — in paper
 * mode the real balance is not what is being traded, so showing it next to
 * simulated figures invites reading one as the other.
 *
 * Deliberately separate from the portfolio stats below it: those are the
 * bot's own ledger of what it has bought and sold, while this is the account
 * balance itself. The two should track each other; when they disagree, this
 * is the one that is true.
 */
function LiveWalletCard({
  wallet, onRefresh,
}: { wallet: Wallet; onRefresh: () => void }) {
  const balance = wallet.balance;
  const unread = balance.solBalance == null;

  return (
    <Card
      title="My wallet"
      action={
        <div className="row" style={{ gap: 8 }}>
          <span className="tag bad">trading live</span>
          <button
            className="btn ghost"
            style={{ padding: '4px 10px', fontSize: 11 }}
            onClick={onRefresh}
          >
            Refresh
          </button>
        </div>
      }
    >
      <div className="grid k4" style={{ gap: 12 }}>
        <Stat
          label="Wallet balance"
          value={unread ? '—' : `${balance.solBalance!.toFixed(4)} SOL`}
          sub={
            balance.balanceUsd != null
              ? usd(balance.balanceUsd)
              : balance.error
                ? 'could not be read'
                : 'pricing SOL…'
          }
        />
        <Stat
          label="SOL price"
          value={balance.solPriceUsd != null ? usd(balance.solPriceUsd) : '—'}
          sub={balance.fetchedAt ? `read ${ago(balance.fetchedAt)}` : 'not read yet'}
        />
        <div style={{ gridColumn: 'span 2' }}>
          <div className="stat-label">Address</div>
          <div className="mono" style={{ fontSize: 12.5, wordBreak: 'break-all', marginTop: 4 }}>
            {wallet.address}
          </div>
          <div className="faint" style={{ fontSize: 11, marginTop: 4 }}>
            {wallet.source === 'env' ? 'Key loaded from .env' : 'Key saved in Settings'}
          </div>
        </div>
      </div>
      {balance.error && (
        <div className="banner warn" style={{ marginTop: 12 }}>
          The balance could not be read: {balance.error}
        </div>
      )}
    </Card>
  );
}

/**
 * One switch for every trading agent.
 *
 * It does not touch the scheduler: mark-to-market and housekeeping keep
 * running either way, so a stopped position is still marked and its stops
 * and targets still fire. This only stops new scans from starting, which is
 * what "stop the agent" means from the outside.
 */
function AgentSwitch({ agents, onPatch }: { agents: AgentRow[]; onPatch: (patch: unknown) => void }) {
  if (agents.length === 0) return null;

  const allOn = agents.every((a) => a.enabled);
  const allOff = agents.every((a) => !a.enabled);
  const state: 'on' | 'off' | 'mixed' = allOn ? 'on' : allOff ? 'off' : 'mixed';
  const running = agents.filter((a) => a.enabled).length;

  const setAll = (enabled: boolean) => onPatch(allAgentsPatch(agents, enabled));

  return (
    <Card
      title="Agents"
      action={
        <span className={`tag ${state === 'on' ? 'ok' : state === 'mixed' ? 'warn' : 'bad'}`}>
          {state === 'on' ? 'all running' : state === 'off' ? 'all stopped' : `${running}/${agents.length} running`}
        </span>
      }
    >
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div>
          <div style={{ fontWeight: 600, marginBottom: 3 }}>
            {state === 'off' ? 'Agents are stopped' : 'Agents are running'}
          </div>
          <div className="dim" style={{ fontSize: 13 }}>
            {state === 'off'
              ? 'No agent will scan for new signals. Open positions are still marked and their stops still fire.'
              : state === 'mixed'
                ? 'Some agents are off. Flip the switch to bring every agent to the same state.'
                : `${agents.map((a) => AGENT_LABELS[a.id] ?? a.id).join(', ')} are all armed.`}
          </div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={state === 'on'}
          aria-label={state === 'off' ? 'Run all agents' : 'Stop all agents'}
          className={`switch ${state}`}
          onClick={() => setAll(state !== 'on')}
        >
          <i />
        </button>
      </div>
    </Card>
  );
}

/**
 * Paper and live.
 *
 * A wallet key is the only thing that arms live trading, and it is entered in
 * Settings. Set the mode here (or with the button in the top corner) and it
 * takes effect immediately: no environment edit, no restart.
 */
function ModeCard({
  data, status, onMode,
}: { data: ConfigResponse; status: Status | null; onMode: (m: 'paper' | 'live') => void }) {
  const effective = data.effectiveMode;
  const configured = data.config.mode;
  const blockers = status?.liveBlockers ?? [];
  const wallet = status?.wallet;

  return (
    <Card
      title="Trading mode"
      action={<span className={`tag ${effective === 'live' ? 'bad' : 'ok'}`}>running on {effective}</span>}
    >
      {configured !== effective && (
        <div className="banner warn" style={{ marginBottom: 14 }}>
          The configuration asks for <b>{configured}</b>, but the system is running on <b>{effective}</b>.
          The blockers below are why.
        </div>
      )}

      <div style={{ marginBottom: 16 }}>
        <div className="stat-label">Wallet</div>
        <div className="mono" style={{ fontSize: 13, wordBreak: 'break-all' }}>
          {wallet?.address ? (
            wallet.address
          ) : (
            <span className="dim">
              Not configured. Paste your private key into Settings → Trading wallet to enable live trading.
            </span>
          )}
        </div>
        {wallet?.error && <div className="down" style={{ fontSize: 12, marginTop: 5 }}>{wallet.error}</div>}
      </div>

      {blockers.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div className="stat-label">Still blocking live trading</div>
          <ul style={{ margin: '6px 0 0', paddingLeft: 20, color: 'var(--text-dim)', fontSize: 13.5 }}>
            {blockers.map((b) => <li key={b}>{b}</li>)}
          </ul>
        </div>
      )}

      <div className="row">
        <button
          className={`btn ${effective === 'paper' ? 'primary' : ''}`}
          disabled={configured === 'paper'}
          onClick={() => onMode('paper')}
        >
          Use paper money
        </button>
        <button
          className="btn"
          // Not gated on `ready`: preflight() checks the mode that is
          // currently configured, so it reports "not ready" right up until
          // this switch is made and can never green-light the click that
          // would make it true. A missing wallet is the one thing that
          // actually should block the click.
          disabled={configured === 'live' || !wallet?.address}
          title={!wallet?.address ? 'Save your wallet private key in Settings first.' : undefined}
          onClick={() => onMode('live')}
        >
          Switch to my live wallet
        </button>
      </div>
    </Card>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="stat-label">{label}</div>
      <div className="mono" style={{ fontSize: 16 }}>{value}</div>
    </div>
  );
}
