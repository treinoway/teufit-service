import { ChallengeFormat, ChallengeStatus, ChallengeVisibility } from '../constants/challenge.js';
import {
  PILLAR_MISSING_NOUNS,
  StudentOverviewState,
  WEEK_COMPLETE_SENTENCE,
  WeekStatus,
  pillarValues,
} from '../constants/consistency-ranking.js';
import { effectiveVisibility, isMinor, visibleFigures } from '../helpers/consistency-anonymize.js';
import { weeklyStatus } from '../helpers/challenge-weeks.js';
import { weekBounds, weekStartFor } from '../helpers/consistency-week.js';
import { civilDateInTimeZone } from '../helpers/date-helpers.js';
import { computeChallengeStandings } from './challenge-consistency-service.js';
import { getConfig, ruleForWeek } from './consistency-config-service.js';
import { getPrivacy } from './consistency-privacy-service.js';
import { evaluateRunningWeek } from './consistency-standings-service.js';

const NO_FIGURES = Object.freeze({ position: null, total: null, faixa: null, average: null });

// Number of a Decimal-like value, or null when absent
function numberOrNull(value) {
  return value === null || value === undefined ? null : Number(value);
}

// Midnight-UTC Date of a civil date
function dbDateOf({ year, month, day }) {
  return new Date(Date.UTC(year, month - 1, day));
}

/**
 * Scoring rule stored on a weekly championship (AD-051), or null for one created without it.
 *
 * @param {{ weights: object|null, activePillars: string[]|null }} challenge
 * @returns {{ weights: object, activePillars: string[] }|null}
 */
export function championshipScoring(challenge) {
  if (!challenge.weights || !Array.isArray(challenge.activePillars) || challenge.activePillars.length === 0) return null;
  return { weights: challenge.weights, activePillars: challenge.activePillars };
}

// "1 treino" or "2 treinos"
function countText(pillar, count) {
  const [singular, plural] = PILLAR_MISSING_NOUNS[pillar];
  return `${count} ${count === 1 ? singular : plural}`;
}

// "Faltam 2 treinos e 1 cardio pra fechar tua semana.", the complete-week sentence, or null without any target
function missingPhraseOf(pillars) {
  if (pillars.length === 0) return null;
  const missing = pillars.filter((row) => row.missing > 0);
  if (missing.length === 0) return WEEK_COMPLETE_SENTENCE;
  const items = missing.map((row) => countText(row.pillar, row.missing));
  const list = items.length === 1 ? items[0] : `${items.slice(0, -1).join(', ')} e ${items[items.length - 1]}`;
  const verb = missing.length === 1 && missing[0].missing === 1 ? 'Falta' : 'Faltam';
  return `${verb} ${list} pra fechar tua semana.`;
}

// Pillar rows of the week: only the active, weighted pillars with a target, in the pillar order (APP-03, AD-063)
function pillarRowsOf(counts, scoring) {
  return pillarValues
    .filter((pillar) => scoring.activePillars.includes(pillar) && (scoring.weights[pillar] ?? 0) > 0 && (counts?.[pillar]?.expected ?? 0) > 0)
    .map((pillar) => {
      const { done, expected } = counts[pillar];
      return { pillar, done, expected, missing: Math.max(expected - done, 0), complete: done >= expected };
    });
}

/**
 * Live week of the student as the home card shows it: score, pillars with what is missing and the "Faltam..." sentence (APP-02 to APP-04).
 *
 * @param {{ status: string, partial: object|null, pillars: object }} outcome - evaluateRunningWeek outcome of the student
 * @param {{ weights: object, activePillars: string[] }} scoring - rule the week was scored with
 * @param {Date} closesAt - close instant of the week
 * @returns {{ score: number|null, status: string, paused: boolean, closesAt: Date, pillars: object[], missingPhrase: string|null }}
 */
export function weekBlockOf(outcome, scoring, closesAt) {
  const pillars = pillarRowsOf(outcome.pillars, scoring);
  return {
    score: numberOrNull(outcome.partial),
    status: outcome.status,
    paused: outcome.status === WeekStatus.PAUSED,
    closesAt,
    pillars,
    missingPhrase: missingPhraseOf(pillars),
  };
}

/**
 * Running week of the student with one trainer, scored with the championship rule when given, else with the trainer's general rule (AD-063).
 *
 * @param {object} prisma
 * @param {string} studentId
 * @param {{ trainerId: string, createdAt: Date }} link - the active trainer link
 * @param {{ weights: object, activePillars: string[] }|null} scoring - championship rule, or null for the general ranking
 * @param {string} timeZone - trainer's time zone
 * @param {Date} now
 * @returns {Promise<object>} weekBlockOf output
 */
export async function studentWeek(prisma, studentId, link, scoring, timeZone, now) {
  const weekStart = weekStartFor(now, timeZone);
  const rule = await ruleForWeek(prisma, link.trainerId, weekStart);
  const options = scoring ? { scoring } : {};
  const outcomes = await evaluateRunningWeek(prisma, link.trainerId, dbDateOf(weekStart), [{ studentId, createdAt: link.createdAt }], options);
  return weekBlockOf(outcomes.get(studentId), scoring ?? rule, weekBounds(weekStart, rule).closeInstant);
}

// Active trainer links of the student, newest first
function activeLinksOf(prisma, studentId) {
  return prisma.trainerStudent.findMany({
    where: { studentId, activeOnPlan: true },
    select: { trainerId: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  });
}

// Highlight order: ends first, then started first, then by name (Assumptions)
function byHighlightOrder(a, b) {
  return a.endDate.getTime() - b.endDate.getTime()
    || a.startDate.getTime() - b.startDate.getTime()
    || a.name.localeCompare(b.name, 'pt-BR', { sensitivity: 'base' });
}

// Time zone of each trainer, keyed by trainer id
async function timeZonesOf(prisma, trainerIds, now) {
  const configs = await Promise.all(trainerIds.map((trainerId) => getConfig(prisma, trainerId, now)));
  return new Map(trainerIds.map((trainerId, index) => [trainerId, configs[index].timeZone]));
}

// Running weekly championships of the student with the actively linked trainers, in highlight order
async function runningChampionships(prisma, studentId, trainerIds, timeZones, now) {
  const challenges = await prisma.challenge.findMany({
    where: { format: ChallengeFormat.WEEKS, cancelledAt: null, trainerId: { in: trainerIds }, participants: { some: { studentId } } },
  });
  return challenges
    .filter((challenge) => weeklyStatus(challenge, { now, timeZone: timeZones.get(challenge.trainerId) }) === ChallengeStatus.ACTIVE)
    .sort(byHighlightOrder);
}

// Own figures of the student in the championship's live standings
async function ownFigures(prisma, studentId, challenge, now) {
  const standings = await computeChallengeStandings(prisma, challenge, now);
  const own = [...standings.rows, ...standings.entering].find((row) => row.studentId === studentId);
  return { position: own?.position ?? null, total: standings.rows.length, faixa: own?.faixa ?? null, average: own?.average ?? null };
}

// Highlighted championship as the card shows it, with the visibility applied (APP-02, APP-06, APP-42)
async function highlightOf(prisma, studentId, challenge, minor, now) {
  const visibility = effectiveVisibility(challenge.visibility, minor);
  const figures = visibility === ChallengeVisibility.OFF ? NO_FIGURES : await ownFigures(prisma, studentId, challenge, now);
  return { challengeId: challenge.id, name: challenge.name, visibility, ...visibleFigures(figures, visibility) };
}

// Whether the student is under 18 on today's date in the time zone
async function isMinorStudent(prisma, studentId, timeZone, now) {
  const user = await prisma.user.findUnique({ where: { id: studentId }, select: { birthDate: true } });
  return isMinor(user?.birthDate ?? null, civilDateInTimeZone(now, timeZone));
}

/**
 * Student overview for the home card and the Ranking tab: live week, highlighted championship, "+N" and the privacy choice.
 *
 * @param {object} prisma
 * @param {string} studentId - User.id
 * @param {Date} [now]
 * @returns {Promise<{ state: string, week: object|null, highlight: object|null, othersCount: number, privacy: object }>}
 */
export async function getStudentOverview(prisma, studentId, now = new Date()) {
  const [links, privacy] = await Promise.all([activeLinksOf(prisma, studentId), getPrivacy(prisma, studentId)]);
  if (links.length === 0) return { state: StudentOverviewState.NO_TRAINER, week: null, highlight: null, othersCount: 0, privacy };

  const trainerIds = [...new Set(links.map((link) => link.trainerId))];
  const timeZones = await timeZonesOf(prisma, trainerIds, now);
  const running = await runningChampionships(prisma, studentId, trainerIds, timeZones, now);
  const highlighted = running[0] ?? null;
  const link = highlighted ? links.find((row) => row.trainerId === highlighted.trainerId) : links[0];
  const timeZone = timeZones.get(link.trainerId);
  const [week, minor] = await Promise.all([
    studentWeek(prisma, studentId, link, highlighted ? championshipScoring(highlighted) : null, timeZone, now),
    isMinorStudent(prisma, studentId, timeZone, now),
  ]);
  const highlight = highlighted ? await highlightOf(prisma, studentId, highlighted, minor, now) : null;
  return { state: StudentOverviewState.OK, week, highlight, othersCount: Math.max(running.length - 1, 0), privacy };
}
