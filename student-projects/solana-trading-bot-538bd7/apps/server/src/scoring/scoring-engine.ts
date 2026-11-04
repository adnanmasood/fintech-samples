import type { ScoringWeights } from '../config/schema.js';
import { normaliseScore } from '../core/money.js';
import type { AgentId, ScoreComponent, TokenScore } from '../core/types.js';
import type { Db } from '../db/client.js';
import { tokenScores } from '../db/schema.js';
import { DIMENSIONS, type DimensionInput, type DimensionKey } from './dimensions.js';

/**
 * The central scoring engine.
 *
 * One weighted sum over the dimensions, with the weights supplied per agent so
 * the hot-trade agent can care about momentum while the small-cap agent cares
 * about security, all without duplicating a single scorer.
 *
 * Two properties matter more than the number itself:
 *   - Every score is explainable. The components, their reasons, the positives
 *     and the risks all travel with the score into the decision log.
 *   - Missing data is visible. `dataCoverage` is the share of the weighted
 *     score that came from real data, and an agent can refuse to act below a
 *     threshold rather than trading on a pile of neutral 50s.
 */
export class ScoringEngine {
  constructor(private readonly db?: Db) {}

  score(
    address: string,
    weights: ScoringWeights,
    input: DimensionInput,
    agent: AgentId | null = null,
  ): TokenScore {
    const components: ScoreComponent[] = [];
    let weighted = 0;
    let totalWeight = 0;
    let realWeight = 0;

    for (const [key, weight] of Object.entries(weights) as Array<[DimensionKey, number]>) {
      if (weight <= 0) continue;
      const dimension = DIMENSIONS[key];
      const result = dimension(input);
      const score = normaliseScore(result.score);
      components.push({ key, weight, ...result, score });
      weighted += score * weight;
      totalWeight += weight;
      if (result.hasData) realWeight += weight;
    }

    const overall = totalWeight > 0 ? normaliseScore(weighted / totalWeight) : 0;
    const dataCoverage = totalWeight > 0 ? realWeight / totalWeight : 0;

    // Order the narrative by how much each component actually moved the score,
    // so the first line a reader sees is the one that mattered most.
    const ranked = [...components].sort((a, b) => b.weight * b.score - a.weight * a.score);
    const positives = dedupe(ranked.flatMap((c) => c.positives)).slice(0, 6);
    const risks = dedupe(
      [...components].sort((a, b) => a.score - b.score).flatMap((c) => c.risks),
    ).slice(0, 6);

    const result: TokenScore = {
      address,
      chain: 'solana',
      agent,
      overall,
      components,
      positives,
      risks,
      dataCoverage,
      scoredAt: input.now,
    };

    this.persist(result);
    return result;
  }

  private persist(score: TokenScore): void {
    if (!this.db) return;
    try {
      this.db
        .insert(tokenScores)
        .values({
          tokenAddress: score.address,
          agent: score.agent,
          overall: score.overall,
          dataCoverage: score.dataCoverage,
          components: score.components,
          positives: score.positives,
          risks: score.risks,
          scoredAt: score.scoredAt,
        })
        .run();
    } catch {
      // Scoring must never fail because the audit write failed.
    }
  }
}

/**
 * The human-readable form of a score, used in the decision log and the
 * dashboard. Kept here so every surface phrases a score the same way.
 */
export function explainScore(score: TokenScore, symbol: string): string {
  const lines: string[] = [];
  lines.push(`${symbol || score.address.slice(0, 8)} scored ${score.overall.toFixed(0)}/100`);
  const sorted = [...score.components].sort((a, b) => b.weight - a.weight);
  for (const c of sorted) {
    lines.push(`  ${c.label}: ${c.score.toFixed(0)} (weight ${(c.weight * 100).toFixed(0)}%) - ${c.reason}`);
  }
  if (score.positives.length > 0) {
    lines.push('Positive:');
    for (const p of score.positives) lines.push(`  + ${p}`);
  }
  if (score.risks.length > 0) {
    lines.push('Risks:');
    for (const r of score.risks) lines.push(`  - ${r}`);
  }
  if (score.dataCoverage < 1) {
    lines.push(`Data coverage: ${(score.dataCoverage * 100).toFixed(0)}% of the score came from real data.`);
  }
  return lines.join('\n');
}

function dedupe(items: string[]): string[] {
  return [...new Set(items.filter((s) => s.trim().length > 0))];
}
