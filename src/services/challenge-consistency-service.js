import { AppError } from '../errors/app-error.js';
import {
  ChallengeErrorCode,
  ChallengeFormat,
  ChallengeMessageCode,
  ChallengeStatus,
} from '../constants/challenge.js';
import { WeekStatus } from '../constants/consistency-ranking.js';
import { currentWeekOf, weeklyStatus } from '../helpers/challenge-weeks.js';
import { currentStreak, isEligible, liveAverage, rankStandings } from '../helpers/consistency-math.js';
import { shortNameOf } from '../helpers/consistency-names.js';
import { weekBounds, weekStartFor } from '../helpers/consistency-week.js';
import { formatDateOnly } from '../helpers/date-helpers.js';
import { getConfig, ruleForWeek } from './consistency-config-service.js';
import { faixaFor } from './consistency-insights-service.js';
import { evaluateRunningWeek } from './consistency-standings-service.js';

const MS_PER_WEEK = 7 * 86400000;
const FULL_SCORE = 100;
const STUDENT_SELECT = { select: { firstName: true, lastName: true, username: true } };
const NOT_RUNNING = Object.freeze({ status: WeekStatus.NEUTRAL, partial: null });

// Civil date of a @db.Date value
function civilOf(date) {
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

// Midnight-UTC Date of a civil date
function dbDateOf({ year, month, day }) {
  return new Date(Date.UTC(year, month - 1, day));
}

// Display name of a student user
function displayName(user) {
  return [user?.firstName, user?.lastName].filter(Boolean).join(' ') || user?.username || '';
}

// Number of a Decimal-like value, or null when absent
function numberOrNull(value) {
  return value === null || value === undefined ? null : Number(value);
}

// Alphabetical order by name (pt-BR, case and accent insensitive)
function byName(a, b) {
  return a.name.localeCompare(b.name, 'pt-BR', { sensitivity: 'base' });
}

// The later of two instants
function laterOf(a, b) {
  return a.getTime() >= b.getTime() ? a : b;
}

// Mondays of the championship, from the start Monday to the Monday of the week holding endDate
function championshipMondays(challenge) {
  const mondays = [];
  for (let time = challenge.startDate.getTime(); time <= challenge.endDate.getTime(); time += MS_PER_WEEK) {
    mondays.push(new Date(time));
  }
  return mondays;
}

// Rule in force for each championship week, keyed by "YYYY-MM-DD" of its Monday (a config change applies from the next week)
async function rulesByWeek(prisma, trainerId, mondays) {
  const rules = await Promise.all(mondays.map((monday) => ruleForWeek(prisma, trainerId, civilOf(monday))));
  return new Map(mondays.map((monday, index) => [formatDateOnly(monday), rules[index]]));
}

// Participants whose trainer link is active on the plan, with when the link was made
async function activeParticipants(prisma, challenge) {
  const participants = await prisma.challengeParticipant.findMany({
    where: { challengeId: challenge.id },
    select: { studentId: true, createdAt: true, student: STUDENT_SELECT },
  });
  if (participants.length === 0) return [];
  const links = await prisma.trainerStudent.findMany({
    where: {
      trainerId: challenge.trainerId,
      activeOnPlan: true,
      studentId: { in: participants.map((row) => row.studentId) },
    },
    select: { studentId: true, createdAt: true },
  });
  const linkedAt = new Map(links.map((link) => [link.studentId, link.createdAt]));
  return participants
    .filter((row) => linkedAt.has(row.studentId))
    .map((row) => ({ ...row, linkedAt: linkedAt.get(row.studentId) }));
}

// Stored weekly results of the students up to the current Monday, grouped by student, newest week first
async function resultsByStudent(prisma, trainerId, studentIds, currentMonday) {
  const rows = await prisma.consistencyWeeklyResult.findMany({
    where: { trainerId, studentId: { in: studentIds }, weekStart: { lte: currentMonday } },
    orderBy: { weekStart: 'desc' },
  });
  const byStudent = new Map();
  for (const row of rows) byStudent.set(row.studentId, [...(byStudent.get(row.studentId) ?? []), row]);
  for (const list of byStudent.values()) list.sort((a, b) => b.weekStart.getTime() - a.weekStart.getTime());
  return byStudent;
}

// Championship weeks that count for a participant: those starting (Monday 00:00) at or after the entry (CAMP-17) and after an edit moved the start (CAMP-11)
function countedWeeks(participant, mondays, rules, startScheduledAt) {
  const entry = startScheduledAt ? laterOf(participant.createdAt, startScheduledAt).getTime() : participant.createdAt.getTime();
  return new Set(
    mondays
      .filter((monday) => weekBounds(civilOf(monday), rules.get(formatDateOnly(monday))).startInstant.getTime() >= entry)
      .map(formatDateOnly),
  );
}

// Running-week outcome of each participant whose current week counts and has no stored result yet
async function runningOutcomes(prisma, trainerId, runningMonday, participants) {
  if (!runningMonday) return new Map();
  const key = formatDateOnly(runningMonday);
  const pending = participants.filter(
    (row) => row.counted.has(key) && !row.results.some((result) => formatDateOnly(result.weekStart) === key),
  );
  if (pending.length === 0) return new Map();
  const links = pending.map((row) => ({ studentId: row.studentId, createdAt: laterOf(row.createdAt, row.linkedAt) }));
  return evaluateRunningWeek(prisma, trainerId, runningMonday, links);
}

// Championship figures of one participant from its counted closed weeks plus the running week
function figuresOf(participant, week, { elapsed, minPodiumWeeks }) {
  const closedValid = participant.results.filter(
    (row) => participant.counted.has(formatDateOnly(row.weekStart)) && row.status === WeekStatus.VALID,
  );
  const validWeeks = closedValid.length + (week.status === WeekStatus.VALID ? 1 : 0);
  return {
    studentId: participant.studentId,
    name: displayName(participant.student),
    user: participant.student,
    eligible: isEligible({ validWeeks, elapsedWeeks: elapsed, minPodiumWeeks }),
    average: liveAverage(closedValid.map((row) => row.score), week.partial),
    validWeeks,
    weeksAt100: closedValid.filter((row) => Number(row.score) >= FULL_SCORE).length,
    streak: currentStreak(participant.results),
    partialScore: week.partial,
    weekStatus: week.status,
  };
}

// Output row of a live participant: ranked (position) or entering (position null, weeks missing)
function liveRow(student, required) {
  return {
    studentId: student.studentId,
    name: student.name,
    ...shortNameOf(student.user),
    position: student.eligible ? student.position : null,
    eligible: student.eligible,
    faixa: faixaFor(student.average, student.eligible),
    average: numberOrNull(student.average),
    validWeeks: student.validWeeks,
    weeks100: student.weeksAt100,
    weeksAt100: student.weeksAt100,
    streak: student.streak,
    currentWeekScore: numberOrNull(student.partialScore),
    weekStatus: student.weekStatus,
    entering: student.eligible ? null : { validWeeks: student.validWeeks, required },
    weeksMissing: student.eligible ? 0 : Math.max(required - student.validWeeks, 0),
  };
}

// Close instant of the running week, or of the last championship week once it has passed
async function closesAtOf(prisma, trainerId, currentMonday, lastMonday) {
  const monday = currentMonday.getTime() > lastMonday.getTime() ? lastMonday : currentMonday;
  const rule = await ruleForWeek(prisma, trainerId, civilOf(monday));
  return weekBounds(civilOf(monday), rule).closeInstant;
}

/**
 * Live consistency standings of a weekly championship: only its weeks and active participants, each from the entry.
 *
 * @param {object} prisma
 * @param {object} challenge - stored weekly championship
 * @param {Date} now
 * @returns {Promise<{ rows: object[], entering: object[], currentWeek: number, closesAt: Date }>}
 */
export async function computeChallengeStandings(prisma, challenge, now) {
  const config = await getConfig(prisma, challenge.trainerId, now);
  const currentMonday = dbDateOf(weekStartFor(now, config.timeZone));
  const mondays = championshipMondays(challenge);
  const lastMonday = mondays[mondays.length - 1];
  const runningMonday = mondays.find((monday) => monday.getTime() === currentMonday.getTime()) ?? null;
  const elapsed = currentWeekOf({ startDate: challenge.startDate, weeks: mondays.length }, currentMonday);
  const minPodiumWeeks = challenge.minPodiumWeeks ?? config.minPodiumWeeks;

  const [rules, participants, closesAt] = await Promise.all([
    rulesByWeek(prisma, challenge.trainerId, mondays),
    activeParticipants(prisma, challenge),
    closesAtOf(prisma, challenge.trainerId, currentMonday, lastMonday),
  ]);
  const results = participants.length > 0
    ? await resultsByStudent(prisma, challenge.trainerId, participants.map((row) => row.studentId), currentMonday)
    : new Map();
  const enriched = participants.map((row) => ({
    ...row,
    counted: countedWeeks(row, mondays, rules, challenge.startScheduledAt),
    results: results.get(row.studentId) ?? [],
  }));
  const outcomes = await runningOutcomes(prisma, challenge.trainerId, runningMonday, enriched);

  const listed = enriched
    .map((row) => figuresOf(row, outcomes.get(row.studentId) ?? NOT_RUNNING, { elapsed, minPodiumWeeks }))
    .filter((student) => student.validWeeks > 0);
  const required = Math.min(minPodiumWeeks, elapsed);
  return {
    rows: rankStandings(listed.filter((student) => student.eligible)).map((student) => liveRow(student, required)),
    entering: listed.filter((student) => !student.eligible).sort(byName).map((student) => liveRow(student, required)),
    currentWeek: elapsed,
    closesAt,
  };
}

// 404 for a missing trainer profile or championship
function notFound(error, messageCode, message) {
  return new AppError({ httpStatus: 404, error, messageCode, message });
}

/**
 * Championship owned by the authenticated trainer (404 unknown trainer or championship, 403 another trainer's).
 *
 * @param {object} prisma
 * @param {string} trainerUserId - authenticated trainer's user id
 * @param {string} challengeId
 * @returns {Promise<object>} stored championship
 */
export async function ownedChallenge(prisma, trainerUserId, challengeId) {
  const trainer = await prisma.trainer.findUnique({ where: { userId: trainerUserId }, select: { id: true } });
  if (!trainer) {
    throw notFound(ChallengeErrorCode.TRAINER_PROFILE_MISSING, ChallengeMessageCode.TRAINER_PROFILE_MISSING, 'Trainer profile not found');
  }
  const challenge = await prisma.challenge.findUnique({ where: { id: challengeId } });
  if (!challenge) {
    throw notFound(ChallengeErrorCode.CHALLENGE_NOT_FOUND, ChallengeMessageCode.CHALLENGE_NOT_FOUND, 'Challenge not found');
  }
  if (challenge.trainerId !== trainer.id) {
    throw new AppError({
      httpStatus: 403,
      error: ChallengeErrorCode.CHALLENGE_FORBIDDEN_NOT_OWNER,
      messageCode: ChallengeMessageCode.CHALLENGE_FORBIDDEN_NOT_OWNER,
      message: 'You do not own this challenge',
    });
  }
  return challenge;
}

// 409 for a championship in the dates format, which has no consistency standings
function assertWeekly(challenge) {
  if (challenge.format !== ChallengeFormat.WEEKS) {
    throw new AppError({
      httpStatus: 409,
      error: ChallengeErrorCode.CHALLENGE_NOT_WEEKLY,
      messageCode: ChallengeMessageCode.CHALLENGE_NOT_WEEKLY,
      message: 'This championship has no consistency standings',
    });
  }
}

// Championship block of the response
function summarize(challenge, participantCount) {
  return {
    id: challenge.id,
    name: challenge.name,
    description: challenge.description ?? null,
    startDate: formatDateOnly(challenge.startDate),
    endDate: formatDateOnly(challenge.endDate),
    weeks: challenge.weeks,
    minPodiumWeeks: challenge.minPodiumWeeks,
    anonymousRanking: challenge.anonymousRanking ?? false,
    visibility: challenge.visibility,
    closeRequestedAt: challenge.closeRequestedAt ?? null,
    closedAt: challenge.closedAt ?? null,
    participantCount,
  };
}

// Orders frozen rows by stored position, then by name for tied students
function byPositionThenName(a, b) {
  if (a.position !== b.position) return (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER);
  return byName(a, b);
}

// Output row of a frozen standing (no running week once closed)
function frozenRow(row, required) {
  return {
    studentId: row.studentId,
    name: row.name,
    ...shortNameOf(row.student),
    position: row.eligible ? row.position : null,
    eligible: row.eligible,
    faixa: faixaFor(row.average, row.eligible),
    average: numberOrNull(row.average),
    validWeeks: row.validWeeks,
    weeks100: row.weeks100,
    weeksAt100: row.weeks100,
    streak: row.streak,
    currentWeekScore: null,
    weekStatus: null,
    entering: row.eligible ? null : { validWeeks: row.validWeeks, required },
    weeksMissing: row.eligible ? 0 : Math.max(required - row.validWeeks, 0),
  };
}

// Final standings stored when the championship closed (CAMP-37: later changes do not touch them)
async function frozenStandings(prisma, challenge) {
  const stored = await prisma.challengeConsistencyStanding.findMany({
    where: { challengeId: challenge.id },
    include: { student: STUDENT_SELECT },
  });
  const required = Math.min(challenge.minPodiumWeeks, challenge.weeks);
  const named = stored.map((row) => ({ ...row, name: displayName(row.student) })).sort(byPositionThenName);
  return {
    rows: named.filter((row) => row.eligible).map((row) => frozenRow(row, required)),
    entering: named.filter((row) => !row.eligible && row.validWeeks > 0).map((row) => frozenRow(row, required)),
  };
}

/**
 * Consistency standings of a weekly championship for its trainer: empty while scheduled or cancelled, live while running, frozen once closed.
 *
 * @param {object} prisma
 * @param {string} trainerUserId - authenticated trainer's user id
 * @param {string} challengeId
 * @param {Date} [now]
 * @returns {Promise<{ challenge: object, status: string, currentWeek: number|null, closesAt: Date|null, rows: object[], entering: object[] }>}
 */
export async function getChallengeConsistency(prisma, trainerUserId, challengeId, now = new Date()) {
  const challenge = await ownedChallenge(prisma, trainerUserId, challengeId);
  assertWeekly(challenge);
  const { timeZone } = await getConfig(prisma, challenge.trainerId, now);
  const status = weeklyStatus(challenge, { now, timeZone });
  const participantCount = await prisma.challengeParticipant.count({ where: { challengeId } });
  const base = { challenge: summarize(challenge, participantCount), status };

  if (status === ChallengeStatus.COMPLETED) {
    return { ...base, currentWeek: challenge.weeks, closesAt: null, ...(await frozenStandings(prisma, challenge)) };
  }
  if (status !== ChallengeStatus.ACTIVE) return { ...base, currentWeek: null, closesAt: null, rows: [], entering: [] };
  const { rows, entering, currentWeek, closesAt } = await computeChallengeStandings(prisma, challenge, now);
  return { ...base, currentWeek, closesAt, rows, entering };
}
