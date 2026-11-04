import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AGENT_LABELS, BUCKET_LABELS, api,
  type ActivityResponse, type AgentRow, type AgentRun, type ConfigResponse,
  type EventRow, type SignalRow, type SocialCatch,
} from '../api';
import { Card, Empty, Score, ago, duration, time } from '../ui';

/**
 * The agent floor.
 *
 * Every number here already existed — in the run history, the decision log and
 * the activity feed — but it was spread across three panels that each told a
 * fraction of the story. This puts one cycle in view end to end: what each
 * agent is doing right now, the funnel a token falls through on its way to
 * becoming a trade, and the reasoning as it happens.
 *
 * The page animates because the underlying thing is genuinely live, not to
 * decorate it. A ring that fills is a scan actually approaching; a pulsing
 * node is an agent actually mid-scan.
 */
export function Agents({
  agents, events, activity, config, busy, onRun,
}: {
  agents: AgentRow[];
  events: EventRow[];
  activity: ActivityResponse | null;
  config: ConfigResponse | null;
  busy: string | null;
  onRun: (id: string) => void;
}) {
  const now = useTick(1_000);
  const runs = useRunHistory(agents);
  const social = useSocial(agents);
  const signals = useSignals(agents);
  const [focus, setFocus] = useState<string | null>(null);
  // A view filter, not a delete: the log keeps everything, this just marks a
  // line in the sand so new decisions are easy to pick out.
  const [clearedAt, setClearedAt] = useState(0);

  if (agents.length === 0) return <Empty>Loading agents…</Empty>;

  const stream = focus ? events.filter((e) => e.agent === focus) : events;
  const totals = aggregate(agents);

  return (
    <>
      <div className="section ag-strip">
        <Pulse label="Agents armed" value={`${totals.armed}/${agents.length}`} live={totals.scanning > 0} />
        <Pulse label="Scanning now" value={String(totals.scanning)} live={totals.scanning > 0} />
        <Pulse label="Tokens screened" value={totals.scanned.toLocaleString()} />
        <Pulse label="Signals raised" value={totals.signals.toLocaleString()} tone="accent" />
        <Pulse
          label="Provider calls"
          value={(activity?.stats.reduce((a, s) => a + s.calls, 0) ?? 0).toLocaleString()}
          sub={`${activity?.stats.reduce((a, s) => a + s.errors, 0) ?? 0} errors`}
        />
      </div>

      <div className="section">
        <Card
          title="Live flow"
          action={
            <div className="row" style={{ gap: 8 }}>
              <span className="faint mono" style={{ fontSize: 11 }}>
                {focus ? AGENT_LABELS[focus] ?? focus : 'all agents'}
                {clearedAt > 0 ? ' · since cleared' : ` · ${stream.length} decisions`}
              </span>
              <button
                className="btn ghost ag-mini"
                onClick={() => setClearedAt(clearedAt > 0 ? 0 : Date.now())}
              >
                {clearedAt > 0 ? 'Show all' : 'Clear'}
              </button>
            </div>
          }
        >
          <Flow
            events={stream.filter((e) => e.createdAt > clearedAt)}
            signals={(focus ? signals.filter((s) => s.agent === focus) : signals)
              .filter((s) => s.createdAt > clearedAt)}
            waiting={totals.armed - totals.scanning}
            scanning={totals.scanning}
          />
        </Card>
      </div>

      <div className="section ag-grid">
        {agents.map((agent) => (
          <AgentNode
            key={agent.id}
            agent={agent}
            runs={runs[agent.id] ?? []}
            now={now}
            busy={busy === agent.id}
            focused={focus === agent.id}
            onFocus={() => setFocus(focus === agent.id ? null : agent.id)}
            onRun={() => onRun(agent.id)}
          />
        ))}
      </div>

      <div className="section">
        <SocialInfluence
          catches={social}
          agents={agents}
          config={config}
          lastRunAt={agents.find((a) => a.id === 'social')?.lastRunAt ?? null}
          onFocus={(id) => setFocus(focus === id ? null : id)}
        />
      </div>

      <div className="section ag-split">
        <Card
          title="Decision stream"
          action={
            focus ? (
              <button className="btn ghost ag-mini" onClick={() => setFocus(null)}>
                Clear filter
              </button>
            ) : (
              <span className="faint mono" style={{ fontSize: 11 }}>all agents</span>
            )
          }
        >
          <Stream events={stream} />
        </Card>

        <Card title="Data providers">
          <ProviderLoad activity={activity} />
        </Card>
      </div>
    </>
  );
}

/* ---------------------------------------------------------------- pipeline */

interface Totals {
  armed: number; scanning: number; scanned: number;
  rejected: number; signals: number; executed: number;
}

function aggregate(agents: AgentRow[]): Totals {
  return {
    armed: agents.filter((a) => a.enabled).length,
    scanning: agents.filter((a) => a.running).length,
    scanned: agents.reduce((a, x) => a + x.tokensScanned, 0),
    rejected: agents.reduce((a, x) => a + x.rejected, 0),
    signals: agents.reduce((a, x) => a + x.signalsGenerated, 0),
    executed: 0,
  };
}

/* ------------------------------------------------------------- live flow */

/**
 * The gates a token passes through, in the order it meets them.
 *
 * These are not illustrative labels — each one is a real place in the server
 * that records a decision, and `classify` below maps a log line back to the
 * gate that produced it.
 */
const STAGES = [
  { key: 'queue', label: 'Waiting', hint: 'agents between scans' },
  { key: 'ingest', label: 'Ingest', hint: 'feed sanity' },
  { key: 'screen', label: 'Screen', hint: 'liquidity · volume · momentum' },
  { key: 'security', label: 'Security', hint: 'contract & holders' },
  { key: 'score', label: 'Score', hint: 'above the floor' },
  { key: 'risk', label: 'Risk', hint: 'sizing · exposure · duplicates' },
  { key: 'execute', label: 'Execute', hint: 'routed on chain' },
  { key: 'outcome', label: 'Outcome', hint: 'where the signal ended' },
] as const;

/** The queue is a source, not a gate, so nothing is ever rejected into it. */
const QUEUE_LANE = 0;
const OUTCOME_LANE = STAGES.length - 1;

/**
 * Rejection stages the signal engine records, mapped onto the gates above.
 * Portfolio limits, duplicate suppression, the kill switch and a mode
 * mismatch are all decided at the risk step, so they land on that gate rather
 * than inventing one apiece.
 */
const STAGE_BY_REJECTION: Record<string, number> = {
  security: 3,
  score: 4,
  risk: 5,
  portfolio: 5,
  duplicate: 5,
  kill_switch: 5,
  mode: 5,
  execution: 6,
};

interface Verdict { lane: number; ok: boolean; token: string; reason: string }

/**
 * Work out which gate a decision-log line came from, whether the token
 * survived it, and which token it was about.
 *
 * Message matching is unavoidable here: the log stores a category and a
 * sentence, and the category alone cannot separate "discarded at ingestion"
 * from "refused by security" — both are logged as `security`. The patterns
 * below mirror the exact strings the server writes, and the captured symbol
 * is what labels the travelling chip.
 */
function classify(event: EventRow): Verdict | null {
  const message = event.message;
  const fallback = event.tokenAddress ? event.tokenAddress.slice(0, 6) : '—';

  // "Discarded <token> at ingestion: <reason>"
  const ingest = /^Discarded (.+?) at ingestion: (.*)$/.exec(message);
  if (ingest) return { lane: 1, ok: false, token: ingest[1], reason: ingest[2] };

  // "Security refused <token>: <reason>"
  const security = /^Security refused (.+?): (.*)$/.exec(message);
  if (security) return { lane: 3, ok: false, token: security[1], reason: security[2] };

  // "Rejected at <stage>: <token> - <reason>"
  const staged = /^Rejected at (\w+): (.+?) - (.*)$/.exec(message);
  if (staged) {
    return {
      lane: STAGE_BY_REJECTION[staged[1]] ?? 5,
      ok: false,
      token: staged[2],
      reason: staged[3],
    };
  }

  // "<agent> passed on <token>: <reason>" is an agent's own structural screen.
  const screened = / passed on (.+?): (.*)$/.exec(message);
  if (screened) return { lane: 2, ok: false, token: screened[1], reason: screened[2] };

  if (event.category === 'risk') return { lane: 5, ok: false, token: fallback, reason: message };
  if (event.category === 'execution') {
    const ok = event.level !== 'error' && event.level !== 'warn';
    return { lane: 6, ok, token: fallback, reason: message };
  }
  if (event.category === 'signal' && event.level === 'info') {
    return { lane: 4, ok: true, token: fallback, reason: message };
  }
  return null;
}

interface Particle { key: string; lane: number; ok: boolean; delay: number; token: string }
interface Drop { key: string; token: string; reason: string }

/**
 * Decisions moving through the gates.
 *
 * Every dot is one real log line, travelling the wire into the gate that
 * judged it: green carries on, red dies there. Because nearly every token is
 * refused somewhere, the picture is mostly red sparks winking out early —
 * which is the system working, and is exactly the shape worth being able to
 * see at a glance.
 *
 * Dots are staggered across the poll window rather than fired all at once, so
 * a batch that arrived together still reads as flow rather than a flash.
 */
function Flow({
  events, signals, waiting, scanning,
}: { events: EventRow[]; signals: SignalRow[]; waiting: number; scanning: number }) {
  const [particles, setParticles] = useState<Particle[]>([]);
  const seen = useRef<Set<number>>(new Set());
  const primed = useRef(false);

  useEffect(() => {
    const fresh: Particle[] = [];
    for (const event of events) {
      if (seen.current.has(event.id)) continue;
      seen.current.add(event.id);
      const verdict = classify(event);
      if (verdict) {
        fresh.push({
          key: `${event.id}`, lane: verdict.lane, ok: verdict.ok, delay: 0, token: verdict.token,
        });
      }
    }
    // The first poll carries the whole backlog. Marking it seen without
    // animating avoids a burst of hundreds of dots on page load.
    if (!primed.current) {
      primed.current = true;
      return;
    }
    if (fresh.length === 0) return;

    // Spread across the poll window by the number actually rendered, not by
    // how many arrived. Dividing by the arrival count collapses the stagger
    // whenever a scan dumps hundreds at once: every dot would fire inside two
    // seconds and the wire would then sit dead until the next poll.
    const shown = fresh.slice(0, 40);
    const batch = shown.map((p, i) => ({ ...p, delay: (i * 5_600) / Math.max(1, shown.length) }));
    setParticles((current) => [...current, ...batch].slice(-70));

    const timer = setTimeout(() => {
      setParticles((current) => current.filter((p) => !batch.some((b) => b.key === p.key)));
    }, 8_000);
    return () => clearTimeout(timer);
  }, [events]);

  // Counts plus the refusals themselves, so each gate can show what it turned
  // away and why rather than only how many.
  const tally = STAGES.map(() => ({ pass: 0, fail: 0, drops: [] as Drop[] }));
  for (const event of events) {
    const verdict = classify(event);
    if (!verdict) continue;
    const cell = tally[verdict.lane];
    if (verdict.ok) {
      cell.pass += 1;
      continue;
    }
    cell.fail += 1;
    // Events arrive newest first, so the first few are the latest refusals.
    if (cell.drops.length < 4) {
      cell.drops.push({ key: `${event.id}`, token: verdict.token, reason: verdict.reason });
    }
  }

  // The terminal gate is answered by the signals themselves rather than the
  // log: a signal's stored status is the authoritative record of whether it
  // ever became a trade, and it survives past the log window.
  const outcome = tally[OUTCOME_LANE];
  const executed = signals.filter((s) => s.status === 'executed').length;
  const refused = signals.filter((s) => s.status === 'rejected' || s.status === 'failed').length;
  const pending = signals.filter((s) => s.status === 'pending' || s.status === 'approved').length;
  outcome.pass = executed;
  outcome.fail = refused;
  outcome.drops = signals
    .filter((s) => s.status !== 'executed')
    .slice(0, 4)
    .map((s) => ({
      key: s.id,
      token: symbolOf(s),
      reason: s.rejectionReason ?? `${s.status}${s.rejectionStage ? ` at ${s.rejectionStage}` : ''}`,
    }));

  // Signals that died after the screen also light their own gate, which is
  // what makes the later blocks move at all once anything gets that far.
  for (const signal of signals) {
    if (!signal.rejectionStage) continue;
    const lane = STAGE_BY_REJECTION[signal.rejectionStage];
    if (lane == null) continue;
    const cell = tally[lane];
    if (cell.drops.some((d) => d.key === signal.id)) continue;
    cell.fail += 1;
    if (cell.drops.length < 4) {
      cell.drops.push({
        key: signal.id,
        token: symbolOf(signal),
        reason: signal.rejectionReason ?? 'refused',
      });
    }
  }

  // The queue is the source: agents waiting between scans, counted as live
  // work rather than as anything that passed or failed a gate.
  const queue = tally[QUEUE_LANE];
  queue.pass = waiting;
  queue.fail = 0;

  return (
    <div className="ag-flow">
      {STAGES.map((stage, i) => {
        const counts = tally[i];
        const busy = particles.some((p) => p.lane === i);
        const isQueue = i === QUEUE_LANE;
        const touched = isQueue || counts.pass > 0 || counts.fail > 0;
        return (
          <div className="ag-flow-cell" key={stage.key}>
            {i > 0 && (
              <div className="ag-wire">
                <span className="ag-wire-line" />
                {particles
                  .filter((p) => p.lane === i)
                  .map((p) => (
                    <span
                      key={p.key}
                      className={`ag-chip ${p.ok ? 'ok' : 'no'}`}
                      style={{ animationDelay: `${p.delay}ms` }}
                    >
                      {p.token.slice(0, 9)}
                    </span>
                  ))}
              </div>
            )}

            <div className="ag-column">
              <div
                className={
                  `ag-gate ${busy ? 'busy' : ''} ${touched ? 'hot' : 'idle'} ` +
                  `${isQueue && scanning > 0 ? 'pulsing' : ''}`
                }
              >
                <div className="ag-gate-name">{stage.label}</div>
                <div className="ag-gate-hint faint">{stage.hint}</div>
                {isQueue ? (
                  <div className="ag-gate-counts">
                    {/* Idle breathes in sequence; a live scan switches to a
                        filling bar, so "waiting" and "working" never look
                        like the same state. */}
                    {scanning > 0 ? (
                      <span className="ag-wait working mono">
                        <i /><i /><i />
                        <em>{scanning} scanning</em>
                      </span>
                    ) : (
                      <span className="ag-wait mono">
                        <i /><i /><i />
                        <em>{waiting} waiting</em>
                      </span>
                    )}
                  </div>
                ) : (
                  <div className="ag-gate-counts">
                    <span className="up mono">{counts.pass}</span>
                    <span className="faint mono">/</span>
                    <span className="down mono">{counts.fail}</span>
                  </div>
                )}
                {i === OUTCOME_LANE && pending > 0 && (
                  <div className="ag-gate-note mono">{pending} pending</div>
                )}
              </div>

              {/* What this gate turned away, and why. The queue refuses
                  nothing, so it gets a note instead of an empty reject box. */}
              <div className={`ag-reject ${counts.drops.length > 0 ? '' : 'empty'}`}>
                {isQueue ? (
                  <span className="ag-reject-idle">agents emit here</span>
                ) : counts.drops.length === 0 ? (
                  <span className="ag-reject-idle">
                    {touched ? 'none refused' : 'nothing reached here'}
                  </span>
                ) : (
                  counts.drops.map((drop) => (
                    <div className="ag-reject-row" key={drop.key} title={`${drop.token}: ${drop.reason}`}>
                      <b>{drop.token.slice(0, 10)}</b>
                      <span>{drop.reason}</span>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Symbols can arrive blank or as a zero-width character; fall back to the mint. */
function symbolOf(signal: SignalRow): string {
  return (
    signal.tokenSymbol.replace(/[\s​-‍﻿]/g, '') ||
    signal.tokenAddress.slice(0, 6)
  );
}

/* --------------------------------------------------------- social influence */

/** Consumers of the social scores, in the order they appear in the diagram. */
const SOCIAL_CONSUMERS = ['hot_trade', 'hidden_gem', 'small_market_cap', 'copy_trade'];

/**
 * What the social agent caught, and where that lands.
 *
 * The social agent is the one agent that never trades. It writes five scores
 * per token and the trading agents read them back through the scoring engine,
 * which makes it the least visible part of the system despite touching every
 * decision the other four make. This card is the missing link: the catches on
 * the left, and on the right how heavily each agent actually weights them.
 *
 * Link thickness and pulse rate are the real configured weight, so an agent
 * that barely listens to social visibly barely listens.
 */
function SocialInfluence({
  catches, agents, config, lastRunAt, onFocus,
}: {
  catches: SocialCatch[];
  agents: AgentRow[];
  config: ConfigResponse | null;
  lastRunAt: number | null;
  onFocus: (id: string) => void;
}) {
  const weights = SOCIAL_CONSUMERS.map((id) => {
    const w = config?.config.agents?.[id]?.weights as
      | { social?: number; sentiment?: number }
      | undefined;
    const share = (w?.social ?? 0) + (w?.sentiment ?? 0);
    return { id, share, agent: agents.find((a) => a.id === id) ?? null };
  }).filter((x) => x.agent);

  const maxShare = Math.max(0.0001, ...weights.map((w) => w.share));
  // Anything written during or after the social agent's last run is what that
  // run turned up, as opposed to older cached scores still in the window.
  const fresh = catches.filter((c) => lastRunAt != null && c.fetchedAt >= lastRunAt).length;

  return (
    <Card
      title="Social intelligence"
      action={
        <span className="faint mono" style={{ fontSize: 11 }}>
          {catches.length} tracked{fresh > 0 ? ` · ${fresh} from the last run` : ''}
        </span>
      }
    >
      <p className="dim ag-social-intro">
        The social agent never trades. It scores tokens on chatter and sentiment, and the four
        trading agents read those scores back when they judge a candidate — so its effect shows up
        as a nudge inside someone else&apos;s decision, never as a signal of its own.
      </p>

      <div className="ag-social">
        <div className="ag-social-catches">
          {catches.length === 0 ? (
            <Empty>Nothing caught yet. The social agent writes a score the first time it sees a token.</Empty>
          ) : (
            catches.slice(0, 8).map((item) => (
              <SocialCatchRow
                key={item.tokenAddress}
                item={item}
                fresh={lastRunAt != null && item.fetchedAt >= lastRunAt}
              />
            ))
          )}
        </div>

        <SocialFan weights={weights} maxShare={maxShare} active={catches.length > 0} onFocus={onFocus} />
      </div>
    </Card>
  );
}

/**
 * Turn the five raw scores into the sentence a person actually wants: what
 * the agent made of this token, and therefore what it is passing on.
 *
 * Order matters. Spam is checked before enthusiasm because a loud, heavily
 * gamed token must not read as a positive, and "no chatter" is checked first
 * of all because a neutral 50/50 with zero mentions is the provider's default
 * rather than a real reading — calling that "balanced" would invent a finding
 * the agent never made.
 */
function socialVerdict(item: SocialCatch): { text: string; tone: 'up' | 'down' | 'dim' } {
  if (item.mentionScore < 10) {
    return { text: 'no chatter found — no effect on scoring', tone: 'dim' };
  }
  if (item.spamScore >= 60) {
    return { text: 'looks coordinated — discounted', tone: 'down' };
  }
  if (item.sentimentScore >= 65 && item.trendScore >= 60) {
    return { text: 'positive and picking up', tone: 'up' };
  }
  if (item.sentimentScore <= 35) {
    return { text: 'negative tone — drags the score', tone: 'down' };
  }
  if (item.trendScore >= 70) {
    return { text: 'mentions spiking', tone: 'up' };
  }
  return { text: 'steady chatter, neutral tone', tone: 'dim' };
}

function SocialCatchRow({ item, fresh }: { item: SocialCatch; fresh: boolean }) {
  const metrics = [
    { key: 'mention', label: 'chatter', value: item.mentionScore, cls: 'm' },
    { key: 'sentiment', label: 'tone', value: item.sentimentScore, cls: 's' },
    { key: 'trend', label: 'trend', value: item.trendScore, cls: 't' },
    { key: 'spam', label: 'spam', value: item.spamScore, cls: 'x' },
  ];
  const verdict = socialVerdict(item);

  return (
    <div className={`ag-catch ${fresh ? 'fresh' : ''}`}>
      <div className="ag-catch-head">
        <b>{item.symbol || item.tokenAddress.slice(0, 6)}</b>
        <span className={`ag-catch-verdict ${verdict.tone}`}>{verdict.text}</span>
        <span className="faint mono ag-catch-age">{ago(item.fetchedAt)}</span>
      </div>
      <div className="ag-catch-metrics">
        {metrics.map((metric) => (
          <div className="ag-catch-metric" key={metric.key}>
            <div className="ag-catch-metric-top">
              <span className="faint">{metric.label}</span>
              <span className="mono">{metric.value.toFixed(0)}</span>
            </div>
            <div className="ag-catch-bar">
              <span
                className={`ag-catch-fill ${metric.cls}`}
                style={{ width: `${Math.min(100, metric.value)}%` }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * The fan-out. One curved wire per consuming agent, carrying a pulse whose
 * speed and thickness track that agent's configured social weight.
 */
function SocialFan({
  weights, maxShare, active, onFocus,
}: {
  weights: Array<{ id: string; share: number; agent: AgentRow | null }>;
  maxShare: number;
  active: boolean;
  onFocus: (id: string) => void;
}) {
  const height = 30 + weights.length * 46;
  const sourceY = height / 2;

  return (
    <div className="ag-fan">
      <svg viewBox={`0 0 300 ${height}`} className="ag-fan-svg" preserveAspectRatio="none" aria-hidden="true">
        {weights.map((w, i) => {
          const y = 28 + i * 46;
          const strength = w.share / maxShare;
          return (
            <g key={w.id}>
              <path
                d={`M 26 ${sourceY} C 130 ${sourceY}, 150 ${y}, 274 ${y}`}
                className="ag-fan-wire"
                style={{ strokeWidth: 1 + strength * 2 }}
              />
              {active && w.share > 0 && (
                <path
                  d={`M 26 ${sourceY} C 130 ${sourceY}, 150 ${y}, 274 ${y}`}
                  className="ag-fan-pulse"
                  style={{
                    strokeWidth: 1.5 + strength * 2.5,
                    // A heavier weight pulses faster, so influence is legible
                    // as rhythm and not only as line thickness.
                    animationDuration: `${2.6 - strength * 1.2}s`,
                    animationDelay: `${i * 0.35}s`,
                  }}
                />
              )}
            </g>
          );
        })}
        <circle cx="26" cy={sourceY} r="9" className="ag-fan-source" />
        <circle cx="26" cy={sourceY} r="9" className="ag-fan-halo" />
      </svg>

      <div className="ag-fan-targets" style={{ height }}>
        {weights.map((w, i) => (
          <button
            key={w.id}
            className="ag-fan-target"
            style={{ top: 28 + i * 46 }}
            onClick={() => onFocus(w.id)}
            title={`Focus ${AGENT_LABELS[w.id] ?? w.id}`}
          >
            <span className="ag-fan-name">{AGENT_LABELS[w.id] ?? w.id}</span>
            <span className="ag-fan-share mono">{(w.share * 100).toFixed(1)}%</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- agent nodes */

function AgentNode({
  agent, runs, now, busy, focused, onFocus, onRun,
}: {
  agent: AgentRow;
  runs: AgentRun[];
  now: number;
  busy: boolean;
  focused: boolean;
  onFocus: () => void;
  onRun: () => void;
}) {
  const state = agent.degraded ? 'bad' : agent.running || busy ? 'run' : agent.enabled ? 'ok' : 'off';
  const label = agent.degraded ? 'degraded' : agent.running || busy ? 'scanning' : agent.enabled ? 'armed' : 'off';

  // Fraction of the way from the last scan to the next one. Indeterminate
  // while a scan is in flight, because there is no meaningful target then.
  const progress = cycleProgress(agent, now);

  return (
    <div className={`card ag-node ${state} ${focused ? 'focused' : ''}`}>
      <div className="ag-node-head">
        <Dial progress={progress} state={state} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="ag-node-name">{AGENT_LABELS[agent.id] ?? agent.id}</div>
          <div className="faint mono ag-node-sub">
            {agent.bucket ? BUCKET_LABELS[agent.bucket] : 'feeds the other agents'}
            {' · every '}{duration(agent.intervalSec * 1000)}
          </div>
        </div>
        <span className={`tag ${state === 'bad' ? 'bad' : state === 'run' ? 'warn' : state === 'ok' ? 'ok' : ''}`}>
          {label}
        </span>
      </div>

      {agent.degraded && <div className="banner bad ag-note">{agent.degradedReason}</div>}
      {agent.lastError && !agent.degraded && (
        <div className="banner bad ag-note">Last run failed: {agent.lastError}</div>
      )}

      <Sparkline runs={runs} />

      <div className="ag-node-stats">
        <Stat2 label="Scanned" value={agent.tokensScanned.toLocaleString()} />
        <Stat2 label="Signals" value={agent.signalsGenerated.toLocaleString()} tone={agent.signalsGenerated > 0 ? 'accent' : undefined} />
        <Stat2 label="Filtered" value={agent.rejected.toLocaleString()} />
        <Stat2 label="Avg score" value={agent.avgScore == null ? '—' : <Score value={agent.avgScore} />} />
        <Stat2 label="Last run" value={ago(agent.lastRunAt)} />
        <Stat2
          label="Next run"
          value={agent.running ? 'now' : agent.enabled ? (agent.nextRunAt ? ago(agent.nextRunAt) : 'soon') : 'paused'}
        />
      </div>

      <div className="ag-node-actions">
        <button className="btn" onClick={onRun} disabled={agent.running || busy}>
          {busy ? 'Scanning…' : 'Scan now'}
        </button>
        <button className="btn ghost ag-mini" onClick={onFocus}>
          {focused ? 'Unfocus' : 'Focus'}
        </button>
        {agent.skippedRuns > 0 && (
          <span className="faint mono" style={{ fontSize: 10.5 }}>
            {agent.skippedRuns} skipped
          </span>
        )}
      </div>
    </div>
  );
}

/** Ring showing how far through its cycle an agent is. */
function Dial({ progress, state }: { progress: number | null; state: string }) {
  const r = 20;
  const circumference = 2 * Math.PI * r;
  const filled = progress == null ? 0.25 : progress;

  return (
    <svg className={`ag-dial ${state} ${progress == null ? 'spin' : ''}`} viewBox="0 0 48 48" aria-hidden="true">
      <circle cx="24" cy="24" r={r} className="ag-dial-track" />
      <circle
        cx="24" cy="24" r={r}
        className="ag-dial-arc"
        strokeDasharray={`${circumference * filled} ${circumference}`}
        transform="rotate(-90 24 24)"
      />
      <circle cx="24" cy="24" r="5" className="ag-dial-core" />
    </svg>
  );
}

/**
 * Recent runs as paired bars: tokens screened behind, signals in front.
 * Oldest on the left, so the eye reads it as time moving forward.
 */
function Sparkline({ runs }: { runs: AgentRun[] }) {
  const series = useMemo(() => runs.slice(0, 28).reverse(), [runs]);
  if (series.length === 0) {
    return <div className="ag-spark empty faint">No runs recorded yet.</div>;
  }
  const max = Math.max(1, ...series.map((r) => r.tokensScanned));

  return (
    <div className="ag-spark" role="img" aria-label={`${series.length} recent runs`}>
      {series.map((run) => {
        const h = (run.tokensScanned / max) * 100;
        const sig = run.signalsGenerated > 0;
        return (
          <div
            className={`ag-spark-bar ${run.status === 'error' ? 'err' : sig ? 'sig' : ''}`}
            key={run.id}
            style={{ height: `${Math.max(3, h)}%` }}
            title={
              `${time(run.startedAt)} · ${run.tokensScanned} scanned · ` +
              `${run.signalsGenerated} signal(s) · ${run.rejected} filtered` +
              (run.error ? ` · ${run.error}` : '')
            }
          />
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ stream */

function Stream({ events }: { events: EventRow[] }) {
  if (events.length === 0) return <Empty>Nothing logged yet.</Empty>;
  return (
    <div className="ag-stream">
      {events.slice(0, 40).map((event) => (
        <div className={`ag-stream-row lvl-${event.level}`} key={event.id}>
          <span className="ag-stream-time mono">{time(event.createdAt)}</span>
          <span className={`ag-stream-cat c-${event.category}`}>{event.category}</span>
          <span className="ag-stream-msg">{event.message}</span>
        </div>
      ))}
    </div>
  );
}

/** Which providers the current workload is actually landing on. */
function ProviderLoad({ activity }: { activity: ActivityResponse | null }) {
  const stats = activity?.stats ?? [];
  if (stats.length === 0) return <Empty>No provider calls recorded yet.</Empty>;
  const max = Math.max(1, ...stats.map((s) => s.calls));

  return (
    <div className="ag-prov">
      {stats.map((stat) => (
        <div className="ag-prov-row" key={stat.provider}>
          <div className="ag-prov-name">
            <b>{stat.provider}</b>
            <span className="faint mono" style={{ fontSize: 10.5 }}>
              {Math.round(stat.avgMs)}ms avg · {stat.cached} cached
              {stat.errors > 0 ? ` · ${stat.errors} errors` : ''}
            </span>
          </div>
          <div className="ag-prov-track">
            <div
              className={`ag-prov-fill ${stat.errors > 0 ? 'err' : ''}`}
              style={{ width: `${(stat.calls / max) * 100}%` }}
            />
          </div>
          <div className="num mono ag-prov-count">{stat.calls.toLocaleString()}</div>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ pieces */

function Pulse({
  label, value, sub, live, tone,
}: { label: string; value: string; sub?: string; live?: boolean; tone?: 'accent' }) {
  return (
    <div className={`card ag-pulse ${live ? 'live' : ''}`}>
      <div className="stat-label">{label}</div>
      <div className={`ag-pulse-value ${tone ?? ''}`}>{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

function Stat2({ label, value, tone }: { label: string; value: React.ReactNode; tone?: 'accent' }) {
  return (
    <div>
      <div className="stat-label">{label}</div>
      <div className={`mono ag-stat-value ${tone ?? ''}`}>{value}</div>
    </div>
  );
}

/* ------------------------------------------------------------------- hooks */

/** Re-render on an interval, so countdowns and rings move between polls. */
function useTick(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

/**
 * Run history per agent.
 *
 * Fetched here rather than in App because this is the only page that needs
 * it, and refreshed on a slower cadence than the main poll: fifty rows per
 * agent is a lot of data to move every eight seconds for bars that barely
 * change between scans.
 */
function useRunHistory(agents: AgentRow[]): Record<string, AgentRun[]> {
  const [runs, setRuns] = useState<Record<string, AgentRun[]>>({});
  const ids = agents.map((a) => a.id).join(',');
  // The last-run timestamps, so a finished scan refreshes the bars promptly
  // instead of waiting out the interval.
  const stamp = agents.map((a) => a.lastRunAt ?? 0).join(',');
  const inFlight = useRef(false);

  useEffect(() => {
    if (!ids) return;
    let cancelled = false;

    const load = async () => {
      if (inFlight.current) return;
      inFlight.current = true;
      try {
        const list = ids.split(',');
        const results = await Promise.all(
          list.map((id) => api.agentRuns(id).catch(() => [] as AgentRun[])),
        );
        if (cancelled) return;
        setRuns(Object.fromEntries(list.map((id, i) => [id, results[i]])));
      } finally {
        inFlight.current = false;
      }
    };

    void load();
    return () => { cancelled = true; };
  }, [ids, stamp]);

  return runs;
}

/**
 * The social agent's catches, refreshed when it finishes a run rather than on
 * the main poll — the scores only change when that agent actually runs.
 */
function useSocial(agents: AgentRow[]): SocialCatch[] {
  const [catches, setCatches] = useState<SocialCatch[]>([]);
  const stamp = agents.find((a) => a.id === 'social')?.lastRunAt ?? 0;

  useEffect(() => {
    let cancelled = false;
    void api.social()
      .then((rows) => { if (!cancelled) setCatches(rows); })
      .catch(() => { /* the card renders its own empty state */ });
    return () => { cancelled = true; };
  }, [stamp]);

  return catches;
}

/**
 * Signal outcomes, refreshed whenever any agent finishes a run — a scan is the
 * only thing that can create one or move it along.
 */
function useSignals(agents: AgentRow[]): SignalRow[] {
  const [signals, setSignals] = useState<SignalRow[]>([]);
  const stamp = agents.map((a) => a.lastRunAt ?? 0).join(',');

  useEffect(() => {
    let cancelled = false;
    void api.signals()
      .then((rows) => { if (!cancelled) setSignals(rows); })
      .catch(() => { /* the gate falls back to its idle state */ });
    return () => { cancelled = true; };
  }, [stamp]);

  return signals;
}

/** How far an agent is through its wait, or null while a scan is running. */
function cycleProgress(agent: AgentRow, now: number): number | null {
  if (agent.running) return null;
  if (!agent.enabled || !agent.nextRunAt) return 0;
  const span = agent.intervalSec * 1000;
  if (span <= 0) return 0;
  const remaining = agent.nextRunAt - now;
  return Math.min(1, Math.max(0, 1 - remaining / span));
}
