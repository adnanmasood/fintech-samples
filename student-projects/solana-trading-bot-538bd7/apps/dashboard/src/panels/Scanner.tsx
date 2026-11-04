import { useState } from 'react';
import type { ListEntry, TokenRow } from '../api';
import { Card, Empty, Pct, Score, price, shorten, usd } from '../ui';

export function Scanner({
  tokens, lists, onList, onRemoveList,
}: {
  tokens: TokenRow[];
  lists: { blacklist: ListEntry[]; whitelist: ListEntry[] } | null;
  onList: (list: 'blacklist' | 'whitelist', address: string) => void;
  onRemoveList: (list: 'blacklist' | 'whitelist', address: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [onlyScored, setOnlyScored] = useState(false);

  const filtered = tokens.filter((token) => {
    if (onlyScored && token.overallScore == null) return false;
    if (!query) return true;
    const needle = query.toLowerCase();
    return (
      token.symbol.toLowerCase().includes(needle) ||
      token.name.toLowerCase().includes(needle) ||
      token.address.toLowerCase().includes(needle)
    );
  });

  return (
    <>
    <div className="section">
    <Card
      title={`Token scanner (${filtered.length})`}
      action={
        <div className="row">
          <label className="row" style={{ gap: 6, fontSize: 12 }}>
            <input
              type="checkbox"
              checked={onlyScored}
              onChange={(e) => setOnlyScored(e.target.checked)}
              style={{ width: 'auto' }}
            />
            <span className="dim">Scored only</span>
          </label>
          <input
            type="text"
            placeholder="Filter by symbol or address"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{ width: 220 }}
          />
        </div>
      }
    >
      {filtered.length === 0 ? (
        <Empty>
          {tokens.length === 0
            ? 'No tokens yet. The agents populate this as they scan, or press Scan now on the Agents page.'
            : onlyScored
              ? `${tokens.length} token${tokens.length === 1 ? '' : 's'} tracked, but none have a score yet. ` +
                'Scoring happens when an agent actually evaluates a token as a candidate, not on discovery alone.'
              : `No token matches "${query}".`}
        </Empty>
      ) : (
        <div className="scroll-x">
          <table>
            <thead>
              <tr>
                <th>Token</th>
                <th className="num">Price</th>
                <th className="num">Market cap</th>
                <th className="num">Liquidity</th>
                <th className="num">Volume 24h</th>
                <th className="num">24h</th>
                <th className="num">Score</th>
                <th className="num">Security</th>
                <th className="num">Social</th>
                <th>Flags</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {filtered.map((token) => (
                <tr key={token.address}>
                  <td>
                    <b>{token.symbol || shorten(token.address)}</b>
                    <div className="faint mono" style={{ fontSize: 10.5 }}>
                      {shorten(token.address, 6)}
                      {token.scoringAgent ? ` · ${token.scoringAgent}` : ''}
                    </div>
                  </td>
                  <td className="num">{price(token.priceUsd)}</td>
                  <td className="num dim">{usd(token.marketCapUsd, 0)}</td>
                  <td className="num dim">{usd(token.liquidityUsd, 0)}</td>
                  <td className="num dim">{usd(token.volume24hUsd, 0)}</td>
                  <td className="num"><Pct value={token.priceChange24h} /></td>
                  <td className="num"><Score value={token.overallScore} /></td>
                  <td className="num"><Score value={token.securityScore} /></td>
                  <td className="num"><Score value={token.socialScore} /></td>
                  <td>
                    {token.blacklisted && <span className="tag bad">blacklisted</span>}
                    {token.whitelisted && <span className="tag ok">whitelisted</span>}
                    {token.riskFlags.slice(0, 2).map((flag) => (
                      <span
                        key={flag.code}
                        className={`tag ${flag.severity === 'critical' || flag.severity === 'high' ? 'bad' : 'warn'}`}
                        title={flag.message}
                      >
                        {flag.code.replace(/_/g, ' ').toLowerCase()}
                      </span>
                    ))}
                  </td>
                  <td className="num">
                    <button
                      className="btn ghost"
                      style={{ padding: '4px 9px', fontSize: 11 }}
                      onClick={() => onList(token.blacklisted ? 'whitelist' : 'blacklist', token.address)}
                    >
                      {token.blacklisted ? 'Unblock' : 'Block'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
    </div>

      <div className="section grid k2">
        <ListCard
          title="Blacklist"
          entries={lists?.blacklist ?? []}
          empty="Nothing blocked. The security agent adds tokens here when it finds a critical flaw."
          onRemove={(address) => onRemoveList('blacklist', address)}
        />
        <ListCard
          title="Whitelist"
          entries={lists?.whitelist ?? []}
          empty="Nothing whitelisted. A whitelist can soften a rules rejection, never a critical one."
          onRemove={(address) => onRemoveList('whitelist', address)}
        />
      </div>
    </>
  );
}

/**
 * One blacklist or whitelist. Lives beside the scanner because that is where
 * tokens are blocked from in the first place — the Block button in the table
 * above is what fills it.
 */
function ListCard({
  title, entries, empty, onRemove,
}: { title: string; entries: ListEntry[]; empty: string; onRemove: (a: string) => void }) {
  return (
    <Card title={`${title} (${entries.length})`}>
      {entries.length === 0 ? (
        <Empty>{empty}</Empty>
      ) : (
        entries.map((entry) => (
          <div className="bucket-row" key={entry.tokenAddress}>
            <div className="bucket-name">
              <b>{entry.symbol || shorten(entry.tokenAddress, 6)}</b>
              <span className="faint" style={{ fontSize: 11 }}>{entry.reason || entry.source}</span>
            </div>
            <button
              className="btn ghost"
              style={{ padding: '4px 10px', fontSize: 11 }}
              onClick={() => onRemove(entry.tokenAddress)}
            >
              Remove
            </button>
          </div>
        ))
      )}
    </Card>
  );
}
