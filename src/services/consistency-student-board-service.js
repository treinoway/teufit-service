import { randomUUID } from 'node:crypto';
import { AppError } from '../errors/app-error.js';
import {
  ChallengeErrorCode,
  ChallengeFormat,
  ChallengeMessageCode,
  ChallengeStatus,
  ChallengeVisibility,
} from '../constants/challenge.js';
import { STUDENT_BOARD_PAGE_SIZE, WeekStatus, WeekStripStatus, pillarValues } from '../constants/consistency-ranking.js';
import {
  displayNameFor,
  effectiveVisibility,
  isMinor,
  neighborsOf,
  peerRow,
  podiumFrom,
  visibleFigures,
} from '../helpers/consistency-anonymize.js';
import { weeklyStatus } from '../helpers/challenge-weeks.js';
import { rescoreClosedWeek } from '../helpers/championship-score.js';
import { weekBounds, weekStartFor } from '../helpers/consistency-week.js';
import { civilDateInTimeZone, formatDateOnly } from '../helpers/date-helpers.js';
import { computeChallengeStandings, frozenStandings } from './challenge-consistency-service.js';
import { getConfig, ruleForWeek } from './consistency-config-service.js';
import { getPrivacy, privacyByStudent } from './consistency-privacy-service.js';
import { championshipScoring, studentWeek } from './consistency-student-overview-service.js';

const MS_PER_WEEK = 7 * 86400000;
const FULL_SCORE = 100;
const PERCENT = 100;
const DECIMAL_FACTOR = 10;
const USER_SELECT = { id: true, firstName: true, lastName: true, username: true, avatarUrl: true, birthDate: true };

// Midnight-UTC Date of a civil date
function dbDateOf({ year, month, day }) {
  return new Date(Date.UTC(year, month - 1, day));
}

// Civil date of a @db.Date value
function civilOf(date) {
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

// Number of a Decimal-like value, or null when absent
function numberOrNull(value) {
  return value === null || value === undefined ? null : Number(value);
}

// 404 for a championship the student cannot read: unknown, not a participant, cancelled or in the dates format (APP-60)
function notFound() {
  return new AppError({
    httpStatus: 404,
    error: ChallengeErrorCode.CHALLENGE_NOT_FOUND,
    messageCode: ChallengeMessageCode.CHALLENGE_NOT_FOUND,
    message: 'Challenge not found',
  });
}

// Weekly championship of the student with the participation row, or a 404
async function readableChampionship(prisma, studentId, challengeId) {
  const [challenge, participant] = await Promise.all([
    prisma.challenge.findUnique({ where: { id: challengeId } }),
    prisma.challengeParticipant.findUnique({ where: { challengeId_studentId: { challengeId, studentId } } }),
  ]);
  if (!challenge || !participant || challenge.cancelledAt || challenge.format !== ChallengeFormat.WEEKS) throw notFound();
  return { challenge, participant };
}

// Championship block of the response
function challengeBlock(challenge, status, currentWeek, participantCount) {
  return {
    id: challenge.id,
    name: challenge.name,
    description: challenge.description ?? null,
    status,
    startDate: formatDateOnly(challenge.startDate),
    endDate: formatDateOnly(challenge.endDate),
    weeks: challenge.weeks,
    currentWeek,
    participantCount,
    closedAt: challenge.closedAt ?? null,
  };
}

// Effective share of each active pillar: its weight over the active weights, in percent with one decimal (APP-29)
function effectiveWeightsOf(scoring) {
  const active = pillarValues.filter((pillar) => scoring.activePillars.includes(pillar));
  const total = active.reduce((sum, pillar) => sum + (scoring.weights[pillar] ?? 0), 0);
  return active.map((pillar) => {
    const weight = scoring.weights[pillar] ?? 0;
    const percent = total === 0 ? 0 : Math.round((weight / total) * PERCENT * DECIMAL_FACTOR) / DECIMAL_FACTOR;
    return { pillar, weight, percent };
  });
}

// Instant the participant started counting: the entry, or a later edit that moved the start (CAMP-11, CAMP-17)
function entryInstantOf(participant, challenge) {
  const entry = participant.createdAt;
  const moved = challenge.startScheduledAt;
  return moved && moved.getTime() > entry.getTime() ? moved : entry;
}

// Strip status of a stored closed week rescored with the championship rule
function closedWeekStatus(row, scoring, entry) {
  const outcome = scoring ? rescoreClosedWeek(row, scoring, entry) : { status: row.status, score: row.score };
  if (outcome.status === WeekStatus.PAUSED) return { status: WeekStripStatus.PAUSED, score: null };
  if (outcome.status !== WeekStatus.VALID) return { status: WeekStripStatus.NEUTRAL, score: null };
  const score = numberOrNull(outcome.score);
  return { status: score >= FULL_SCORE ? WeekStripStatus.FULL : WeekStripStatus.BELOW, score };
}

// Status and score of one championship week for the student
function stripWeek(monday, startInstant, ctx) {
  if (monday.getTime() > ctx.currentMonday.getTime()) return { status: WeekStripStatus.FUTURE, score: null };
  if (startInstant.getTime() < ctx.entryInstant.getTime()) return { status: WeekStripStatus.NEUTRAL, score: null };
  const stored = ctx.results.get(formatDateOnly(monday));
  if (stored) return closedWeekStatus(stored, ctx.scoring, { linkedAt: ctx.linkedAt, weekStartInstant: startInstant });
  if (monday.getTime() === ctx.currentMonday.getTime() && ctx.liveWeek) {
    return ctx.liveWeek.paused ? { status: WeekStripStatus.PAUSED, score: null } : { status: WeekStripStatus.LIVE, score: ctx.liveWeek.score };
  }
  return { status: WeekStripStatus.NEUTRAL, score: null };
}

// Week strip of the championship: full, below, paused, neutral (outside the championship), live or future (APP-27)
async function weekStripOf(prisma, challenge, studentId, ctx) {
  const mondays = Array.from({ length: challenge.weeks }, (_, index) => new Date(challenge.startDate.getTime() + index * MS_PER_WEEK));
  const [rules, rows] = await Promise.all([
    Promise.all(mondays.map((monday) => ruleForWeek(prisma, challenge.trainerId, civilOf(monday)))),
    prisma.consistencyWeeklyResult.findMany({
      where: { trainerId: challenge.trainerId, studentId, weekStart: { gte: mondays[0], lte: mondays[mondays.length - 1] } },
    }),
  ]);
  const results = new Map(rows.map((row) => [formatDateOnly(row.weekStart), row]));
  return mondays.map((monday, index) => ({
    week: index + 1,
    weekStart: formatDateOnly(monday),
    ...stripWeek(monday, weekBounds(civilOf(monday), rules[index]).startInstant, { ...ctx, results }),
  }));
}

// Users (names, photo, birth date) of the listed participants, keyed by id
async function usersById(prisma, studentIds) {
  if (studentIds.length === 0) return new Map();
  const users = await prisma.user.findMany({ where: { id: { in: studentIds } }, select: USER_SELECT });
  return new Map(users.map((user) => [user.id, user]));
}

// Function turning a standings row into what the viewer sees (opaque key per response, APP-41)
function peerViewer({ viewerId, users, privacies, today, anonymousRanking }) {
  const keys = new Map();
  return (row) => {
    if (!keys.has(row.studentId)) keys.set(row.studentId, randomUUID());
    const user = users.get(row.studentId);
    return peerRow(row, {
      key: keys.get(row.studentId),
      isMe: row.studentId === viewerId,
      avatarUrl: user?.avatarUrl ?? null,
      privacy: privacies.get(row.studentId),
      isMinor: isMinor(user?.birthDate ?? null, today),
      anonymousRanking,
    });
  };
}

// Page of the classified list, 20 rows per page (APP-14)
function pageOf(items, page) {
  const totalPages = Math.max(1, Math.ceil(items.length / STUDENT_BOARD_PAGE_SIZE));
  const start = (page - 1) * STUDENT_BOARD_PAGE_SIZE;
  return { page, pageSize: STUDENT_BOARD_PAGE_SIZE, totalPages, items: items.slice(start, start + STUDENT_BOARD_PAGE_SIZE) };
}

// Classification the viewer sees: podium or Clube 100%, neighbors, entering, total and one page of the full list, anonymized
function boardOf(standings, viewer, studentId, page) {
  const classified = standings.rows.map(viewer);
  const meIndex = standings.rows.findIndex((row) => row.studentId === studentId);
  const entering = standings.entering.map((row) => ({
    ...viewer(row),
    validWeeks: row.validWeeks,
    required: row.entering?.required ?? null,
    weeksMissing: row.weeksMissing,
  }));
  return {
    ...podiumFrom(classified),
    neighbors: neighborsOf(classified, meIndex),
    entering,
    total: classified.length,
    ...pageOf(classified, page),
  };
}

// Others sharing the 1st place with the student, or null when the student is not 1st (APP-31)
function firstPlaceSharedOf(own, rows) {
  if (own?.position !== 1) return null;
  return rows.filter((row) => row.position === 1 && row.studentId !== own.studentId).length;
}

// Ranking figures of the student, without the ones the visibility hides (APP-26, APP-61)
function rankingFiguresOf(own, standings, closedWeeks, visibility) {
  const figures = visibleFigures(
    { position: own?.position ?? null, total: standings.rows.length, faixa: own?.faixa ?? null, average: own?.average ?? null },
    visibility,
  );
  if (visibility === ChallengeVisibility.OFF) {
    return { ...figures, weeks100: null, streak: null, entering: null, firstPlaceShared: null };
  }
  return {
    ...figures,
    weeks100: { done: own?.weeksAt100 ?? 0, of: closedWeeks },
    streak: own?.streak ?? 0,
    entering: own && !own.eligible ? { validWeeks: own.validWeeks, required: own.entering?.required ?? null, weeksMissing: own.weeksMissing } : null,
    firstPlaceShared: firstPlaceSharedOf(own, standings.rows),
  };
}

// Standings of a running or closed championship with its current week and close instant
async function standingsOf(prisma, challenge, status, now) {
  if (status === ChallengeStatus.COMPLETED) {
    const frozen = await frozenStandings(prisma, challenge);
    return { ...frozen, currentWeek: challenge.weeks, closesAt: null, closedWeeks: challenge.weeks };
  }
  const live = await computeChallengeStandings(prisma, challenge, now);
  return { ...live, closedWeeks: Math.max(live.currentWeek - 1, 0) };
}

// Live week of the student in the running championship (APP-28), or null when closed or without an active link
async function liveWeekOf(prisma, studentId, link, scoring, timeZone, status, now) {
  if (status !== ChallengeStatus.ACTIVE || !link) return null;
  return studentWeek(prisma, studentId, link, scoring, timeZone, now);
}

// Full anonymized classification for a championship with visibility "full"
async function fullBoard(prisma, standings, studentId, challenge, today, page) {
  const ids = [...standings.rows, ...standings.entering].map((row) => row.studentId);
  const [users, privacies] = await Promise.all([usersById(prisma, ids), privacyByStudent(prisma, ids)]);
  const viewer = peerViewer({ viewerId: studentId, users, privacies, today, anonymousRanking: challenge.anonymousRanking });
  return boardOf(standings, viewer, studentId, page);
}

// "Minha constância" of the student: how others see them, ranking figures, live week, week strip and the championship weights (APP-25 to APP-29)
async function meOf(prisma, { challenge, participant, viewer, standings, status, timeZone, visibility }, now) {
  const scoring = championshipScoring(challenge);
  const link = await prisma.trainerStudent.findFirst({
    where: { trainerId: challenge.trainerId, studentId: viewer.id, activeOnPlan: true },
    select: { trainerId: true, createdAt: true },
  });
  const liveWeek = await liveWeekOf(prisma, viewer.id, link, scoring, timeZone, status, now);
  const weekStrip = await weekStripOf(prisma, challenge, viewer.id, {
    currentMonday: dbDateOf(weekStartFor(now, timeZone)),
    entryInstant: entryInstantOf(participant, challenge),
    linkedAt: link?.createdAt,
    scoring,
    liveWeek,
  });
  const own = [...standings.rows, ...standings.entering].find((row) => row.studentId === viewer.id);
  return {
    appearsAs: displayNameFor(viewer.user, { privacy: viewer.privacy.appearAs, isMinor: viewer.minor, anonymousRanking: challenge.anonymousRanking }),
    ...rankingFiguresOf(own, standings, standings.closedWeeks, visibility),
    week: liveWeek,
    weekStrip,
    effectiveWeights: scoring ? effectiveWeightsOf(scoring) : [],
  };
}

// The viewer: user, privacy choice and whether they are a minor today
async function viewerOf(prisma, studentId, today) {
  const [user, privacy] = await Promise.all([
    prisma.user.findUnique({ where: { id: studentId }, select: USER_SELECT }),
    getPrivacy(prisma, studentId),
  ]);
  return { id: studentId, user: user ?? {}, privacy, minor: isMinor(user?.birthDate ?? null, today) };
}

/**
 * A championship's consistency classification and "Minha constância" as one participant sees them (scheduled: championship only; running: live; closed: frozen).
 *
 * @param {object} prisma
 * @param {string} studentId - User.id of the viewer
 * @param {string} challengeId
 * @param {{ page?: number }} [options] - 1-based page of the full list
 * @param {Date} [now]
 * @returns {Promise<{ challenge: object, visibility: string, closesAt: Date|null, me: object|null, board: object|null, privacy: object }>}
 */
export async function getStudentBoard(prisma, studentId, challengeId, { page = 1 } = {}, now = new Date()) {
  const { challenge, participant } = await readableChampionship(prisma, studentId, challengeId);
  const { timeZone } = await getConfig(prisma, challenge.trainerId, now);
  const status = weeklyStatus(challenge, { now, timeZone });
  const today = civilDateInTimeZone(now, timeZone);
  const [participantCount, viewer] = await Promise.all([
    prisma.challengeParticipant.count({ where: { challengeId } }),
    viewerOf(prisma, studentId, today),
  ]);
  const visibility = effectiveVisibility(challenge.visibility, viewer.minor);
  const base = { visibility, privacy: viewer.privacy };
  if (status === ChallengeStatus.SCHEDULED) {
    return { challenge: challengeBlock(challenge, status, null, participantCount), ...base, closesAt: null, me: null, board: null };
  }

  const standings = await standingsOf(prisma, challenge, status, now);
  const me = await meOf(prisma, { challenge, participant, viewer, standings, status, timeZone, visibility }, now);
  const board = visibility === ChallengeVisibility.FULL ? await fullBoard(prisma, standings, studentId, challenge, today, Math.max(1, page)) : null;
  return { challenge: challengeBlock(challenge, status, standings.currentWeek, participantCount), ...base, closesAt: standings.closesAt, me, board };
}
