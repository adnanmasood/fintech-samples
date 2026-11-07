import { useCallback, useEffect, useState } from 'react';
import {
  allAgentsPatch, api, type ActivityResponse, type AgentRow, type Allocations, type ConfigResponse,
  type EventRow, type ListEntry, type Portfolio, type PositionRow, type Status, type TokenRow,
  type TradeRow, type TradeSummary, type Wallet,
} from './api';
import { BrandMark, duration } from './ui';
import { Overview } from './panels/Overview';
import { Agents } from './panels/Agents';
import { Scanner } from './panels/Scanner';
import { Trades } from './panels/Trades';
import { DecisionLog } from './panels/DecisionLog';
import { Settings } from './panels/Settings';
import { Activity } from './panels/Activity';

type Tab = 'overview' | 'agents' | 'scanner' | 'trades' | 'log' | 'activity' | 'settings';

const TABS: Array<[Tab, string]> = [
  ['overview', 'Overview'],
  ['agents', 'Agents'],
  ['scanner', 'Token scanner'],
  ['trades', 'Trade history'],
  ['log', 'Decision log'],
  ['activity', 'Activity'],
  ['settings', 'Settings'],
];

export default function App() {
  const [tab, setTab] = useState<Tab>('overview');
  const [status, setStatus] = useState<Status | null>(null);
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [positions, setPositions] = useState<PositionRow[]>([]);
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [tokens, setTokens] = useState<TokenRow[]>([]);
  const [trades, setTrades] = useState<TradeRow[]>([]);
  const [summary, setSummary] = useState<TradeSummary | null>(null);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [lists, setLists] = useState<{ blacklist: ListEntry[]; whitelist: ListEntry[] } | null>(null);
  const [activity, setActivity] = useState<ActivityResponse | null>(null);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastGoodAt, setLastGoodAt] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyAgent, setBusyAgent] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [s, p, pos, a, t, tr, sum, ev, cfg, ls, act, w] = await Promise.all([
        api.status(), api.portfolio(), api.positions(), api.agents(), api.tokens(),
        api.trades(), api.tradeSummary(), api.events(), api.config(), api.lists(), api.activity(),
        api.wallet(),
      ]);
      setStatus(s); setPortfolio(p); setPositions(pos); setAgents(a); setTokens(t);
      setTrades(tr); setSummary(sum); setEvents(ev); setConfig(cfg); setLists(ls); setActivity(act);
      setWallet(w);
      setError(null);
      setLastGoodAt(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reach the server.');
    }
  }, []);

  useEffect(() => {
    void refresh();
    // Polling keeps this simple. The API is local, so the cost is
    // negligible and there is no socket to reconnect after a server restart.
    const timer = setInterval(() => void refresh(), 8_000);
    return () => clearInterval(timer);
  }, [refresh]);

  // A toast that never goes away is not a toast, it is a fixture. Five
  // seconds is enough to read a one-line confirmation; an error stays because
  // the user asked for it by clicking something, so it deserves a re-read.
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 5_000);
    return () => clearTimeout(timer);
  }, [notice]);

  const act = useCallback(
    async (fn: () => Promise<unknown>, successMessage?: string) => {
      try {
        await fn();
        if (successMessage) setNotice(successMessage);
        await refresh();
      } catch (err) {
        setNotice(err instanceof Error ? err.message : 'That did not work.');
      }
    },
    [refresh],
  );

  const mode = status?.mode ?? 'paper';
  const agentsAllOn = agents.length > 0 && agents.every((a) => a.enabled);
  const agentsAllOff = agents.length > 0 && agents.every((a) => !a.enabled);
  const walletReady = Boolean(wallet?.address);

  const goLive = (next: 'paper' | 'live') =>
    act(async () => {
      const result = await api.setMode(next);
      if (result.effectiveMode !== result.requestedMode) {
        throw new Error(
          `Set to ${result.requestedMode}, but still running on ${result.effectiveMode}. ` +
            result.blockers.join(' '),
        );
      }
      // The mode switch reseeds the buckets, so say what the agents will
      // actually be trading with rather than just "now live".
      const funded = result.funded;
      if (funded?.source === 'wallet' && funded.solBalance != null) {
        setNotice(
          `Now running live on ${funded.solBalance.toFixed(4)} SOL ` +
            `(about $${funded.balanceUsd.toFixed(2)}).`,
        );
      } else if (funded?.source === 'paper') {
        setNotice(`Back on paper money, reset to $${funded.balanceUsd.toFixed(2)}.`);
      } else {
        setNotice(`Now running on ${next}.`);
      }
    });

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand"><BrandMark /> USF Console</div>
        <div className="brand-sub">Solana multi-agent</div>
        <nav className="nav">
          {TABS.map(([id, label]) => (
            <button key={id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </nav>
        {status && (
          <div className="build-stamp" title={`Server started ${new Date(status.startedAt).toLocaleString()}`}>
            v{status.appVersion}
            <span> · up {duration(Date.now() - status.startedAt)}</span>
          </div>
        )}
      </aside>

      <main className="main">
        <div className="topbar">
          <h1>{TABS.find(([id]) => id === tab)?.[1]}</h1>
          <div className="row">
            <span className={`pill ${mode}`}>{mode} mode</span>
            {error && <span className="pill danger">disconnected</span>}
            <button
              className={`btn ${mode === 'live' ? '' : 'primary'}`}
              // Not gated on liveReady: preflight() checks the *current*
              // stored mode, so it reports "not ready" right up until the
              // switch is made - it can never green-light the click that
              // would make it true. It is still worth knowing about, so it
              // drives the tooltip; the wallet/blockchain checks below do the
              // actual gating.
              disabled={mode === 'paper' && !walletReady}
              title={
                mode === 'paper' && !walletReady
                  ? 'Save your wallet private key in Settings → Trading wallet first.'
                  : undefined
              }
              onClick={() => void goLive(mode === 'paper' ? 'live' : 'paper')}
            >
              {mode === 'paper' ? 'Go live' : 'Switch to paper'}
            </button>
            <button
              className="btn"
              disabled={agentsAllOn}
              onClick={() => void act(() => api.patchConfig(allAgentsPatch(agents, true)), 'Agents running.')}
            >
              Run agents
            </button>
            <button
              className="btn ghost"
              disabled={agentsAllOff}
              onClick={() => void act(() => api.patchConfig(allAgentsPatch(agents, false)), 'Agents stopped.')}
            >
              Stop agents
            </button>
          </div>
        </div>

        {error && (
          <div className="banner bad">
            Cannot reach the server: {error}
            {lastGoodAt && ` Showing data from ${duration(Date.now() - lastGoodAt)} ago.`}
          </div>
        )}
        {config?.liveRequestedButNotArmed && (
          <div className="banner warn">
            Live mode is set in the configuration, but no wallet key is configured, so paper mode is
            still in force. Add your private key under Settings → Trading wallet to go live.
          </div>
        )}
        {wallet?.error && <div className="banner bad">{wallet.error}</div>}

        {tab === 'overview' && (
          <Overview
            portfolio={portfolio}
            positions={positions}
            status={status}
            summary={summary}
            config={config}
            agents={agents}
            wallet={wallet}
            onPatch={(patch) => act(() => api.patchConfig(patch), 'Settings saved.')}
            onMode={(next) => void goLive(next)}
            onRefreshWallet={() =>
              void act(async () => setWallet(await api.wallet(true)), 'Balance refreshed.')
            }
          />
        )}
        {tab === 'agents' && (
          <Agents
            agents={agents}
            events={events}
            activity={activity}
            config={config}
            busy={busyAgent}
            onRun={(id) => {
              setBusyAgent(id);
              void act(() => api.runAgent(id), `${id} finished a scan.`).finally(() => setBusyAgent(null));
            }}
          />
        )}
        {tab === 'scanner' && (
          <Scanner
            tokens={tokens}
            lists={lists}
            onList={(list, address) =>
              act(() => api.addToList(list, address, 'set from the token scanner'), `Added to the ${list}.`)
            }
            onRemoveList={(list, address) => act(() => api.removeFromList(list, address), 'Removed.')}
          />
        )}
        {tab === 'trades' && <Trades trades={trades} />}
        {tab === 'log' && <DecisionLog events={events} />}
        {tab === 'activity' && (
          <Activity data={activity} onClear={() => act(() => api.clearActivity(), 'Feed cleared.')} />
        )}
        {tab === 'settings' && (
          <Settings
            data={config}
            wallet={wallet}
            onPatch={(patch) => act(() => api.patchConfig(patch), 'Settings saved.')}
            onAllocations={(a: Allocations) => act(() => api.setAllocations(a), 'Allocation saved.')}
            onFund={(amount) => act(() => api.fund(amount), 'Paper balance updated.')}
            // Not routed through `act`: it turns a failure into a toast and
            // resolves, which would let the card clear a key the server
            // rejected. A rejected paste has to stay in the box to be fixed.
            onSaveKey={async (privateKey) => {
              try {
                const saved = await api.saveWalletKey(privateKey);
                setWallet(saved);
                setNotice(`Wallet saved: ${saved.address}. You can go live now.`);
                await refresh();
              } catch (err) {
                setNotice(err instanceof Error ? err.message : 'That key was not accepted.');
                throw err;
              }
            }}
            onRemoveKey={() =>
              act(async () => setWallet(await api.removeWalletKey()), 'Wallet key removed.')
            }
          />
        )}
      </main>

      {notice && (
        <div className="toast" onClick={() => setNotice(null)} role="status">
          {notice} <span className="faint">(click to dismiss)</span>
        </div>
      )}
    </div>
  );
}
