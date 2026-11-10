import { Prisma } from '@prisma/client';
import { WeekStatus } from '../constants/consistency-ranking.js';

const { Decimal } = Prisma;

const SCORE_DECIMAL_PLACES = 4;
const FULL_SCORE = new Decimal(100);

// Rounds a score or average to the stored and compared precision (4 places, half up)
function quantize(value) {
  return new Decimal(value).toDecimalPlaces(SCORE_DECIMAL_PLACES, Decimal.ROUND_HALF_UP);
}

// Adherence of one pillar: done over expected, capped at 100%
function pillarAdherence(expected, done) {
  const ratio = new Decimal(done ?? 0).dividedBy(expected);
  return Decimal.min(ratio, new Decimal(1));
}

// Weekly score from per-pillar targets and counts, or null when no active pillar has a target
export function scoreWeek({ expected, done, weights, activePillars }) {
  const counted = activePillars.filter((pillar) => (weights[pillar] ?? 0) > 0 && (expected[pillar] ?? 0) > 0);
  if (counted.length === 0) return null;

  let weighted = new Decimal(0);
  let totalWeight = new Decimal(0);
  for (const pillar of counted) {
    const weight = new Decimal(weights[pillar]);
    weighted = weighted.plus(weight.times(pillarAdherence(expected[pillar], done[pillar])));
    totalWeight = totalWeight.plus(weight);
  }
  return quantize(weighted.times(FULL_SCORE).dividedBy(totalWeight));
}

// Arithmetic mean of scores quantized to 4 places, or null for an empty list
function averageOf(scores) {
  if (scores.length === 0) return null;
  const sum = scores.reduce((acc, score) => acc.plus(score), new Decimal(0));
  return quantize(sum.dividedBy(scores.length));
}

// Live season average: the higher of the closed-weeks average and the one including the partial week (AD-002)
export function liveAverage(closedScores, partial) {
  const closedAverage = averageOf(closedScores);
  if (partial === null || partial === undefined) return closedAverage;
  if (closedAverage === null) return quantize(partial);
  const withPartial = averageOf([...closedScores, partial]);
  return Decimal.max(closedAverage, withPartial);
}

// Whether the student has enough valid weeks (including the running one) for the podium
export function isEligible({ validWeeks, elapsedWeeks, minPodiumWeeks }) {
  return validWeeks >= Math.min(minPodiumWeeks, elapsedWeeks);
}

// Consecutive closed weeks at 100, most recent first, skipping neutral and paused weeks
export function currentStreak(results) {
  let streak = 0;
  for (const result of results) {
    if (result.status !== WeekStatus.VALID) continue;
    if (quantize(result.score).lt(FULL_SCORE)) break;
    streak += 1;
  }
  return streak;
}

// Compares two rows by average, weeks at 100 and streak (descending), then by name
function compareRows(a, b) {
  const byAverage = quantize(b.average).comparedTo(quantize(a.average));
  if (byAverage !== 0) return byAverage;
  if (b.weeksAt100 !== a.weeksAt100) return b.weeksAt100 - a.weeksAt100;
  if (b.streak !== a.streak) return b.streak - a.streak;
  return a.name.localeCompare(b.name, 'pt-BR', { sensitivity: 'base' });
}

// Whether two rows tie on average, weeks at 100 and streak
function isTied(a, b) {
  return (
    quantize(a.average).eq(quantize(b.average)) && a.weeksAt100 === b.weeksAt100 && a.streak === b.streak
  );
}

// Sorts rows and assigns positions; full ties share a position and skip the following ones
export function rankStandings(rows) {
  const sorted = [...rows].sort(compareRows);
  const ranked = [];
  sorted.forEach((row, index) => {
    const previous = ranked[index - 1];
    const position = previous && isTied(previous, row) ? previous.position : index + 1;
    ranked.push({ ...row, position });
  });
  return ranked;
}
