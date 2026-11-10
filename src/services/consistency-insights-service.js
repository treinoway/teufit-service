import {
  FAIXA_THRESHOLDS,
  Faixa,
  PILLAR_TIE_ORDER,
  SignalType,
  WeekStatus,
} from '../constants/consistency-ranking.js';

const SECONDS_PER_MINUTE = 60;
const MS_PER_MINUTE = 60000;
const FULL_SCORE = 100;
const ADHERENCE_SCALE = 10000;

/**
 * Season band of a student from the season average (AD-011).
 *
 * @param {number|{ toNumber: Function }} average
 * @param {boolean} eligible - false while the student lacks the minimum weeks for the podium
 * @returns {string} one of Faixa
 */
export function faixaFor(average, eligible) {
  if (!eligible) return Faixa.ENTERING;
  const value = Number(average);
  if (value >= FULL_SCORE) return Faixa.FULL;
  if (value >= FAIXA_THRESHOLDS.constant) return Faixa.CONSTANT;
  if (value >= FAIXA_THRESHOLDS.steady) return Faixa.STEADY;
  return Faixa.RESTARTING;
}

// Scores of the newest valid weeks in a row that stay below the limit (newest first)
function consecutiveBelow(validResults, riskLimit) {
  const scores = [];
  for (const row of validResults) {
    const score = Number(row.score);
    if (score >= riskLimit) break;
    scores.push(score);
  }
  return scores;
}

/**
 * Risk of a student: the last riskWeeks valid closed weeks all below riskLimit; neutral and paused weeks are skipped.
 *
 * @param {Array<{ status: string, score: * }>} closedResults - most recent first
 * @param {{ riskLimit: number, riskWeeks: number }} rules
 * @returns {{ atRisk: boolean, scores: number[] }} scores of every valid week in a row below the limit (at least riskWeeks), oldest first
 */
export function riskFor(closedResults, { riskLimit, riskWeeks }) {
  const below = consecutiveBelow(closedResults.filter((row) => row.status === WeekStatus.VALID), riskLimit);
  return below.length >= riskWeeks ? { atRisk: true, scores: below.reverse() } : { atRisk: false, scores: [] };
}

// Adds the counts of one valid week to the per-pillar totals, counting a week over target as the target
function addWeekTotals(totals, pillars) {
  for (const [pillar, counts] of Object.entries(pillars ?? {})) {
    const current = totals.get(pillar) ?? { done: 0, expected: 0 };
    totals.set(pillar, {
      done: current.done + Math.min(counts.done, counts.expected),
      expected: current.expected + counts.expected,
    });
  }
}

/**
 * Per-pillar totals of the valid closed weeks of a season; pillars without a target are left out.
 *
 * @param {Array<{ status: string, pillars: object }>} closedResults
 * @returns {Array<{ pillar: string, done: number, expected: number, adherence: number }>} adherence is a percentage with 4 places
 */
export function seasonPillars(closedResults) {
  const totals = new Map();
  for (const row of closedResults) {
    if (row.status === WeekStatus.VALID) addWeekTotals(totals, row.pillars);
  }
  return PILLAR_TIE_ORDER.filter((pillar) => (totals.get(pillar)?.expected ?? 0) > 0).map((pillar) => {
    const { done, expected } = totals.get(pillar);
    const adherence = Math.round((done / expected) * FULL_SCORE * ADHERENCE_SCALE) / ADHERENCE_SCALE;
    return { pillar, done, expected, adherence };
  });
}

/**
 * Pillar with the lowest adherence; ties follow Workouts, Cardio, Feedback, Hydration, Diet.
 *
 * @param {Array<{ pillar: string, adherence: number }>} pillars
 * @returns {string|null}
 */
export function weakestPillar(pillars) {
  const ordered = [...pillars].sort(
    (a, b) => a.adherence - b.adherence || PILLAR_TIE_ORDER.indexOf(a.pillar) - PILLAR_TIE_ORDER.indexOf(b.pillar),
  );
  return ordered[0]?.pillar ?? null;
}

// Quick-completion signals: sessions shorter than the configured minimum
function quickCompletions(sessions, minWorkoutMinutes) {
  const minimumSeconds = minWorkoutMinutes * SECONDS_PER_MINUTE;
  return sessions
    .filter((session) => session.durationSeconds !== null && session.durationSeconds < minimumSeconds)
    .map((session) => ({
      type: SignalType.QUICK_COMPLETION,
      sessionId: session.id,
      finishedAt: session.finishedAt,
      durationSeconds: session.durationSeconds,
      thresholdMinutes: minWorkoutMinutes,
    }));
}

// Batch-logging signal: batchCount or more sessions finished in the batchMinutes up to the close
function batchLogging(sessions, closeInstant, { batchCount, batchMinutes }) {
  const closeMs = closeInstant.getTime();
  const windowStart = closeMs - batchMinutes * MS_PER_MINUTE;
  const inWindow = sessions.filter((session) => {
    const finished = session.finishedAt.getTime();
    return finished > windowStart && finished <= closeMs;
  });
  const count = inWindow.length;
  if (count < batchCount) return [];
  const lastFinishedAt = new Date(Math.max(...inWindow.map((session) => session.finishedAt.getTime())));
  return [{ type: SignalType.BATCH_LOGGING, count, closeInstant, windowMinutes: batchMinutes, lastFinishedAt }];
}

/**
 * Signals to review in the sessions of one student and week; signals never change the score (PAN-52).
 *
 * @param {Array<{ id: string, finishedAt: Date, durationSeconds: number|null }>} sessions - completed sessions of the week
 * @param {Date} closeInstant - close of the week
 * @param {{ minWorkoutMinutes: number, batchCount: number, batchMinutes: number }} rules
 * @returns {object[]} quick-completion signals followed by the batch-logging signal, if any
 */
export function signalsFor(sessions, closeInstant, rules) {
  return [...quickCompletions(sessions, rules.minWorkoutMinutes), ...batchLogging(sessions, closeInstant, rules)];
}
