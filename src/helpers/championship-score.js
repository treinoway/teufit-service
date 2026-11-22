import { WeekStatus } from '../constants/consistency-ranking.js';
import { scoreWeek } from './consistency-math.js';

// Per-pillar expected and done counts of a stored weekly result
function countsOf(pillars) {
  const expected = {};
  const done = {};
  for (const [pillar, counts] of Object.entries(pillars ?? {})) {
    expected[pillar] = counts?.expected ?? 0;
    done[pillar] = counts?.done ?? 0;
  }
  return { expected, done };
}

// Whether a neutral stored week would have scored under the rule stored with it, which means it went neutral by late entry
function isNeutralByEntry(row, counts) {
  const stored = row.weights;
  if (!stored?.weights || !Array.isArray(stored.activePillars)) return false;
  return scoreWeek({ ...counts, weights: stored.weights, activePillars: stored.activePillars }) !== null;
}

/**
 * Status and score of a closed week in a championship, from the stored result and the championship's scoring rule (AD-060).
 *
 * @param {{ status: string, pillars: object, weights: object|null }} row - stored ConsistencyWeeklyResult
 * @param {{ weights: object, activePillars: string[] }} scoring - the championship's rule
 * @returns {{ status: string, score: object|null }} score is a Decimal for a valid week
 */
export function rescoreClosedWeek(row, scoring) {
  if (row.status === WeekStatus.PAUSED) return { status: WeekStatus.PAUSED, score: null };
  const counts = countsOf(row.pillars);
  if (row.status === WeekStatus.NEUTRAL && isNeutralByEntry(row, counts)) return { status: WeekStatus.NEUTRAL, score: null };
  const score = scoreWeek({ ...counts, weights: scoring.weights, activePillars: scoring.activePillars });
  return score === null ? { status: WeekStatus.NEUTRAL, score: null } : { status: WeekStatus.VALID, score };
}
