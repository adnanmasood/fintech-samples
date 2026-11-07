import { useEffect, useState } from 'react';
import {
  BUCKET_LABELS, type Allocations, type BucketId, type ConfigResponse, type Wallet,
} from '../api';
import { Card, Empty, shorten, usd } from '../ui';

interface FollowedWallet {
  address: string;
  label: string;
  enabled: boolean;
}

const BUCKETS: BucketId[] = ['copy_trading', 'hot_trading', 'hidden_gems', 'low_market_cap'];

const RISK_FIELDS: Array<[string, string, string]> = [
  ['maxPositionUsd', 'Max position (USD)', 'Hard ceiling on any single trade.'],
  ['minPositionUsd', 'Min position (USD)', 'Below this a trade is not worth making.'],
  ['maxPositionPctOfBucket', 'Max position (% of bucket)', ''],
  ['maxBucketExposurePct', 'Max bucket exposure (%)', ''],
  ['maxTotalExposurePct', 'Max total exposure (%)', ''],
  ['maxDailyLossPct', 'Max daily loss (%)', 'Trading halts for the day past this.'],
  ['maxOpenPositions', 'Max open positions', ''],
  ['maxOpenPositionsPerBucket', 'Max open per bucket', ''],
  ['stopLossPct', 'Stop loss (%)', ''],
  ['takeProfitPct', 'Take profit (%)', ''],
  ['trailingStopPct', 'Trailing stop (%)', 'Zero turns it off.'],
  ['maxSlippageBps', 'Max slippage (bps)', ''],
  ['minLiquidityUsd', 'Min liquidity (USD)', ''],
  ['maxTokenConcentrationPct', 'Max single token (%)', ''],
  ['duplicateTradeCooldownSec', 'Duplicate cooldown (s)', ''],
  ['maxTradesPerAgentPerHour', 'Max trades per agent per hour', ''],
  ['minSecurityScore', 'Min security score', ''],
];

export function Settings({
  data, wallet, onPatch, onAllocations, onFund, onSaveKey, onRemoveKey,
}: {
  data: ConfigResponse | null;
  wallet: Wallet | null;
  onPatch: (patch: unknown) => void;
  onAllocations: (a: Allocations) => void;
  onFund: (amount: number) => void;
  onSaveKey: (privateKey: string) => Promise<void>;
  onRemoveKey: () => Promise<void>;
}) {
  const [alloc, setAlloc] = useState<Allocations | null>(null);
  const [risk, setRisk] = useState<Record<string, number>>({});
  const [fundAmount, setFundAmount] = useState('1000');

  useEffect(() => {
    if (!data) return;
    setAlloc(data.config.portfolio.allocations);
    const next: Record<string, number> = {};
    for (const [key] of RISK_FIELDS) {
      const value = data.config.risk[key];
      if (typeof value === 'number') next[key] = value;
    }
    setRisk(next);
  }, [data]);

  if (!data || !alloc) return <Empty>Loading configuration…</Empty>;

  const total = BUCKETS.reduce((acc, b) => acc + (alloc[b] ?? 0), 0);
  const balanced = Math.abs(total - 100) < 0.01;

  return (
    <>
      <div className="section">
        <WalletKeyCard wallet={wallet} onSave={onSaveKey} onRemove={onRemoveKey} />
      </div>

      <div className="section">
        <Card
          title="Bucket allocation"
          action={
            <span className={`tag ${balanced ? 'ok' : 'bad'}`}>
              {total.toFixed(1)}% {balanced ? 'balanced' : 'must total 100%'}
            </span>
          }
        >
          <div className="grid k4" style={{ gap: 12 }}>
            {BUCKETS.map((bucket) => (
              <label className="field" key={bucket}>
                <span>{BUCKET_LABELS[bucket]}</span>
                <input
                  type="number"
                  min={0}
                  max={100}
                  step={1}
                  value={alloc[bucket]}
                  onChange={(e) => setAlloc({ ...alloc, [bucket]: Number(e.target.value) })}
                />
              </label>
            ))}
          </div>
          <div className="row">
            <button className="btn primary" disabled={!balanced} onClick={() => onAllocations(alloc)}>
              Save allocation
            </button>
            <span className="faint" style={{ fontSize: 12 }}>
              Only uninvested cash moves. Open positions keep the bucket they were opened in.
            </span>
          </div>
        </Card>
      </div>

      <div className="section">
        <Card title="Risk limits">
          <div className="grid k4" style={{ gap: 12 }}>
            {RISK_FIELDS.map(([key, label, hint]) => (
              <label className="field" key={key}>
                <span title={hint}>{label}</span>
                <input
                  type="number"
                  value={risk[key] ?? 0}
                  onChange={(e) => setRisk({ ...risk, [key]: Number(e.target.value) })}
                />
              </label>
            ))}
          </div>
          <button className="btn primary" onClick={() => onPatch({ risk })}>Save risk limits</button>
        </Card>
      </div>

      <div className="section grid k2">
        <Card title="Agents">
          {Object.entries(data.config.agents).map(([id, cfg]) => (
            <div className="bucket-row" key={id}>
              <div className="bucket-name">
                <b>{id.replace(/_/g, ' ')}</b>
                <span className="faint mono" style={{ fontSize: 11 }}>
                  every {Math.round(Number(cfg.intervalSec ?? 0) / 60)} min
                  {cfg.minScore != null && ` · min score ${String(cfg.minScore)}`}
                </span>
              </div>
              <button
                className="btn ghost"
                onClick={() => onPatch({ agents: { [id]: { enabled: !cfg.enabled } } })}
              >
                {cfg.enabled ? 'Turn off' : 'Turn on'}
              </button>
            </div>
          ))}
        </Card>

        <Card title="Paper balance">
          <p className="dim" style={{ marginTop: 0, fontSize: 13 }}>
            Add or remove simulated cash. It is split across the buckets by their allocation.
            Live balances come from the wallet and cannot be set here.
          </p>
          <div className="row">
            <input
              type="number"
              value={fundAmount}
              onChange={(e) => setFundAmount(e.target.value)}
              style={{ width: 160 }}
            />
            <button className="btn" onClick={() => onFund(Number(fundAmount))}>Add</button>
            <button className="btn" onClick={() => onFund(-Number(fundAmount))}>Remove</button>
          </div>
        </Card>
      </div>

      <div className="section">
        <WalletsCard
          wallets={(data.config.agents.copy_trade.followedWallets as FollowedWallet[] | undefined) ?? []}
          onSave={(wallets) => onPatch({ agents: { copy_trade: { followedWallets: wallets } } })}
        />
      </div>

    </>
  );
}

/**
 * The trading wallet's private key.
 *
 * The key goes one way: typed here, encrypted, stored, and never sent back.
 * Once saved, live trading is armed immediately — the Go live button stops
 * being disabled and no restart is involved. What is shown afterwards is the
 * derived public address, which is the useful half anyway: it is how you
 * confirm the right wallet went in.
 */
function WalletKeyCard({
  wallet, onSave, onRemove,
}: {
  wallet: Wallet | null;
  onSave: (privateKey: string) => Promise<void>;
  onRemove: () => Promise<void>;
}) {
  const [entry, setEntry] = useState('');
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);

  const configured = wallet?.configured ?? false;
  const balance = wallet?.balance;
  const showForm = editing || !configured;

  const save = async () => {
    setBusy(true);
    try {
      await onSave(entry);
      setEntry('');
      setReveal(false);
      setEditing(false);
    } catch {
      // Already surfaced as a toast. Leave the key in the box to be corrected.
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await onRemove();
      setEditing(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="Trading wallet"
      action={
        <span className={`tag ${configured ? 'ok' : 'warn'}`}>
          {configured ? `key stored${wallet?.source === 'env' ? ' (.env)' : ''}` : 'no key'}
        </span>
      }
    >
      {configured && (
        <div className="grid k2" style={{ gap: 12, marginBottom: 14 }}>
          <div>
            <div className="stat-label">Private key</div>
            <div className="mono" style={{ fontSize: 15, letterSpacing: 2 }}>
              ••••••••••••••••••••
            </div>
            <div className="faint" style={{ fontSize: 11, marginTop: 3 }}>
              Encrypted on this machine. It is never shown again or sent to the browser.
            </div>
          </div>
          <div>
            <div className="stat-label">Wallet address</div>
            <div className="mono" style={{ fontSize: 12.5, wordBreak: 'break-all' }}>
              {wallet?.address}
            </div>
            <div className="faint" style={{ fontSize: 11, marginTop: 3 }}>
              {balance?.solBalance != null
                ? `${balance.solBalance.toFixed(4)} SOL${
                    balance.balanceUsd != null ? ` · ${usd(balance.balanceUsd)}` : ''
                  }`
                : balance?.error
                  ? `Balance unavailable: ${balance.error}`
                  : 'Reading the balance…'}
            </div>
          </div>
        </div>
      )}

      {wallet?.error && (
        <div className="banner bad" style={{ marginBottom: 14 }}>{wallet.error}</div>
      )}

      {showForm ? (
        <>
          <p className="dim" style={{ marginTop: 0, fontSize: 13 }}>
            Paste the private key of the Solana wallet you want the bot to trade with. Phantom and
            Solflare copy it as base58; a <code>solana-keygen</code> keyfile array works too. Saving
            it is all that is needed to go live — there is nothing else to configure.
          </p>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <input
              type={reveal ? 'text' : 'password'}
              placeholder="Private key"
              autoComplete="off"
              spellCheck={false}
              value={entry}
              onChange={(e) => setEntry(e.target.value)}
              style={{ minWidth: 320, flex: 1, fontFamily: 'var(--mono, monospace)' }}
            />
            <button className="btn ghost" type="button" onClick={() => setReveal(!reveal)}>
              {reveal ? 'Hide' : 'Show'}
            </button>
            <button className="btn primary" disabled={busy || !entry.trim()} onClick={() => void save()}>
              {busy ? 'Saving…' : 'Save key'}
            </button>
            {configured && (
              <button className="btn ghost" disabled={busy} onClick={() => { setEditing(false); setEntry(''); }}>
                Cancel
              </button>
            )}
          </div>
        </>
      ) : (
        <div className="row">
          <button className="btn" disabled={busy} onClick={() => setEditing(true)}>
            Replace key
          </button>
          {wallet?.source === 'settings' && (
            <button className="btn ghost" disabled={busy} onClick={() => void remove()}>
              Remove key
            </button>
          )}
          <span className="faint" style={{ fontSize: 12 }}>
            {wallet?.source === 'env'
              ? 'This key comes from WALLET_PRIVATE_KEY in .env. Saving one here overrides it.'
              : 'Removing the key drops the bot back to paper mode.'}
          </span>
        </div>
      )}
    </Card>
  );
}

/**
 * The copy-trade agent copies trades from wallets on this list, and only
 * this list — it never discovers wallets on its own. An empty list is why it
 * runs every cycle scanning zero tokens: there is nothing for it to follow.
 */
function WalletsCard({
  wallets, onSave,
}: { wallets: FollowedWallet[]; onSave: (wallets: FollowedWallet[]) => void }) {
  const [address, setAddress] = useState('');
  const [label, setLabel] = useState('');
  const [error, setError] = useState('');

  const add = () => {
    const trimmed = address.trim();
    if (trimmed.length < 32) {
      setError('That does not look like a Solana wallet address.');
      return;
    }
    if (wallets.some((w) => w.address === trimmed)) {
      setError('Already following that wallet.');
      return;
    }
    setError('');
    onSave([...wallets, { address: trimmed, label: label.trim(), enabled: true }]);
    setAddress('');
    setLabel('');
  };

  const toggle = (target: string) => {
    onSave(wallets.map((w) => (w.address === target ? { ...w, enabled: !w.enabled } : w)));
  };

  const remove = (target: string) => {
    onSave(wallets.filter((w) => w.address !== target));
  };

  return (
    <Card title={`Copy trade — followed wallets (${wallets.length})`}>
      <p className="dim" style={{ marginTop: 0, fontSize: 13 }}>
        The copy-trade agent only ever watches wallets added here — it never finds them on its own.
        With none followed, it has nothing to copy and every run scans zero tokens.
      </p>
      {wallets.length === 0 ? (
        <Empty>No wallets followed yet. Paste one below to start watching it.</Empty>
      ) : (
        wallets.map((wallet) => (
          <div className="bucket-row" key={wallet.address}>
            <div className="bucket-name">
              <b>{wallet.label || shorten(wallet.address, 6)}</b>
              <span className="faint mono" style={{ fontSize: 11 }}>{shorten(wallet.address, 6)}</span>
            </div>
            <div className="row" style={{ gap: 8 }}>
              <button className="btn ghost" style={{ padding: '4px 10px', fontSize: 11 }} onClick={() => toggle(wallet.address)}>
                {wallet.enabled ? 'Pause' : 'Resume'}
              </button>
              <button className="btn ghost" style={{ padding: '4px 10px', fontSize: 11 }} onClick={() => remove(wallet.address)}>
                Remove
              </button>
            </div>
          </div>
        ))
      )}
      <div className="row" style={{ marginTop: 12, flexWrap: 'wrap' }}>
        <input
          placeholder="Wallet address"
          value={address}
          onChange={(e) => { setAddress(e.target.value); setError(''); }}
          style={{ minWidth: 260 }}
        />
        <input
          placeholder="Label (optional)"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          style={{ width: 160 }}
        />
        <button className="btn primary" onClick={add}>Follow wallet</button>
      </div>
      {error && <p style={{ color: 'var(--bad, #e5484d)', fontSize: 12, marginBottom: 0 }}>{error}</p>}
    </Card>
  );
}

