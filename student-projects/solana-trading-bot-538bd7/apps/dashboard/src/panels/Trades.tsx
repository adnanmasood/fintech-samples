import { AGENT_LABELS, BUCKET_LABELS, type TradeRow } from '../api';
import { Card, Empty, Money, Score, dateTime, price, shorten, usd } from '../ui';

export function Trades({ trades }: { trades: TradeRow[] }) {
  if (trades.length === 0) {
    return (
      <Card title="Trade history">
        <Empty>No trades yet. Every one that happens lands here with the reason behind it.</Empty>
      </Card>
    );
  }

  return (
    <Card title={`Trade history (${trades.length})`}>
      <div className="scroll-x">
        <table>
          <thead>
            <tr>
              <th>Time</th><th>Token</th><th>Agent</th><th>Bucket</th><th>Side</th>
              <th className="num">Price</th><th className="num">Amount</th>
              <th className="num">Fees</th><th className="num">P&amp;L</th>
              <th className="num">Score</th><th>Reason</th>
            </tr>
          </thead>
          <tbody>
            {trades.map((trade) => (
              <tr key={trade.id}>
                <td className="mono faint" style={{ fontSize: 11 }}>{dateTime(trade.executedAt)}</td>
                <td>
                  <b>{trade.tokenSymbol || shorten(trade.tokenAddress)}</b>
                  {trade.mode === 'paper' && (
                    <div className="faint mono" style={{ fontSize: 10 }}>paper</div>
                  )}
                </td>
                <td className="dim">{AGENT_LABELS[trade.agent] ?? trade.agent}</td>
                <td className="dim">{BUCKET_LABELS[trade.bucket]}</td>
                <td><span className={`tag ${trade.side}`}>{trade.side}</span></td>
                <td className="num">{price(trade.priceUsd)}</td>
                <td className="num dim">{usd(trade.grossUsd)}</td>
                <td className="num faint">{usd(trade.feesUsd)}</td>
                <td className="num">
                  {trade.side === 'sell' ? <Money value={trade.realizedPnlUsd} /> : <span className="dim">—</span>}
                </td>
                <td className="num"><Score value={trade.score} /></td>
                <td className="dim" style={{ maxWidth: 340, minWidth: 220 }}>{trade.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
