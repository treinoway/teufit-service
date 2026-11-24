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

// Whether the student's trainer link began after the week started (Monday 00:00), which makes the week neutral by late entry
function joinedAfterStart(entry) {
  if (!entry?.linkedAt || !entry?.weekStartInstant) return false;
  return entry.linkedAt.getTime() > entry.weekStartInstant.getTime();
}

/**
 * Status and score of a closed week in a championship, from the stored result and the championship's scoring rule (AD-060).
 *
 * @param {{ status: string, pillars: object, weights: object|null }} row - stored ConsistencyWeeklyResult
 * @param {{ weights: object, activePillars: string[] }} scoring - the championship's rule
 * @param {{ linkedAt: Date, weekStartInstant: Date }} [entry] - when the student's trainer link began and when the week started
 * @returns {{ status: string, score: object|null }} score is a Decimal for a valid week
 */
export function rescoreClosedWeek(row, scoring, entry) {
  if (row.status === WeekStatus.PAUSED) return { status: WeekStatus.PAUSED, score: null };
  const counts = countsOf(row.pillars);
  if (row.status === WeekStatus.NEUTRAL && joinedAfterStart(entry)) return { status: WeekStatus.NEUTRAL, score: null };
  const score = scoreWeek({ ...counts, weights: scoring.weights, activePillars: scoring.activePillars });
  return score === null ? { status: WeekStatus.NEUTRAL, score: null } : { status: WeekStatus.VALID, score };
}
