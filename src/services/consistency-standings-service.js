import { AppError } from '../errors/app-error.js';
import {
  ConsistencyErrorCode,
  ConsistencyMessageCode,
  PANEL_DEFAULTS,
  Pillar,
  SeasonStatus,
  StandingsFilter,
  WeekStatus,
} from '../constants/consistency-ranking.js';
import { isEligible, liveAverage, rankStandings, scoreWeek, seasonFigures } from '../helpers/consistency-math.js';
import {
  countFilters,
  filterStandings,
  searchStandings,
  sortForFilter,
  teamSummary,
} from '../helpers/consistency-standings-query.js';
import { shortNameOf } from '../helpers/consistency-names.js';
import { doneWindow, weekBounds, weekStartFor } from '../helpers/consistency-week.js';
import { getConfig, ruleForWeek } from './consistency-config-service.js';
import { faixaFor, riskFor, seasonPillars, signalsFor } from './consistency-insights-service.js';
import { countDone, listSessions } from './consistency-progress-service.js';
import { pauseReasonsFor, pausesFor } from './consistency-pause-service.js';
import { ensureCurrentSeason, seasonNotStartedReason } from './consistency-season-service.js';
import { materializeTargets } from './consistency-target-service.js';

const MS_PER_WEEK = 7 * 86400000;
const NO_COUNTS = Object.freeze({ workouts: 0, cardio: 0 });
const STUDENT_SELECT = { select: { firstName: true, lastName: true, username: true } };

// "YYYY-MM-DD" of a @db.Date value
function dateKey(date) {
  return date.toISOString().slice(0, 10);
}

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

// 404 for a season number the trainer does not have
function seasonNotFoundError() {
  return new AppError({
    httpStatus: 404,
    error: ConsistencyErrorCode.SEASON_NOT_FOUND,
    messageCode: ConsistencyMessageCode.SEASON_NOT_FOUND,
    message: 'Consistency season not found',
  });
}

// Season block of the response, with currentWeek as "X" of the season's Y weeks
function summarizeSeason(season, currentWeek) {
  const lastMonday = new Date(season.startWeek.getTime() + (season.weeks - 1) * MS_PER_WEEK);
  return {
    number: season.number,
    startWeek: dateKey(season.startWeek),
    endWeek: dateKey(lastMonday),
    weeks: season.weeks,
    currentWeek,
    status: season.status,
  };
}

// 1-based index of the running week inside the season, clamped to its length
function elapsedWeeksOf(season, mondayDate) {
  const index = Math.round((mondayDate.getTime() - season.startWeek.getTime()) / MS_PER_WEEK) + 1;
  return Math.min(Math.max(index, 1), season.weeks);
}

// Per-pillar expected and done counts of the tracked pillars
function pillarCounts(expected, done) {
  return {
    [Pillar.WORKOUTS]: { expected: expected.workouts, done: done.workouts },
    [Pillar.CARDIO]: { expected: expected.cardio, done: done.cardio },
  };
}

// Status and partial score of one student's running week (joined late -> neutral, paused, no target -> neutral)
function weekOutcome(link, ctx) {
  const expected = ctx.targets.get(link.studentId) ?? NO_COUNTS;
  const done = ctx.done.get(link.studentId) ?? NO_COUNTS;
  const pillars = pillarCounts(expected, done);
  const neutral = { status: WeekStatus.NEUTRAL, partial: null, pillars };
  if (link.createdAt.getTime() > ctx.startInstant.getTime()) return neutral;
  const pause = ctx.pauses.students.has(link.studentId) ? ctx.pauses.students.get(link.studentId) : ctx.pauses.team;
  if (pause) return { status: WeekStatus.PAUSED, partial: null, pillars };
  const partial = scoreWeek({ expected, done, weights: ctx.scoring.weights, activePillars: ctx.scoring.activePillars });
  return partial === null ? neutral : { status: WeekStatus.VALID, partial, pillars };
}

/**
 * Evaluates the running week of every linked student with one read per kind (joined after Monday 00:00 -> neutral, paused, no target -> neutral).
 *
 * @param {object} prisma
 * @param {string} trainerId - Trainer.id
 * @param {Date} mondayDate - midnight-UTC Date of the running week's Monday
 * @param {Array<{ studentId: string, createdAt: Date }>} links - createdAt is when the student started counting
 * @param {{ scoring?: { weights: object, activePillars: string[] } }} [options] - scoring replaces the trainer's weights and pillars in the score (a championship's rule); close, window, entry and pauses stay the trainer's
 * @returns {Promise<Map<string, { status: string, partial: object|null, pillars: object }>>} outcome per student id
 */
export async function evaluateRunningWeek(prisma, trainerId, mondayDate, links, { scoring } = {}) {
  const weekStart = civilOf(mondayDate);
  const rule = await ruleForWeek(prisma, trainerId, weekStart);
  const previousRule = await ruleForWeek(prisma, trainerId, civilOf(new Date(mondayDate.getTime() - MS_PER_WEEK)));
  const window = doneWindow(weekStart, rule, previousRule);
  const ids = links.map((link) => link.studentId);
  const [targets, done, pauses] = await Promise.all([
    materializeTargets(prisma, trainerId, weekStart, ids),
    countDone(prisma, trainerId, ids, window),
    pausesFor(prisma, trainerId, [weekStart]),
  ]);
  const startInstant = weekBounds(weekStart, rule).startInstant;
  const ctx = { scoring: scoring ?? rule, targets, done, pauses: pauses.get(dateKey(mondayDate)), startInstant };
  return new Map(links.map((link) => [link.studentId, weekOutcome(link, ctx)]));
}

// Stored results of the students grouped by student, most recent week first
async function readResultsByStudent(prisma, trainerId, studentIds, mondayDate) {
  const rows = await prisma.consistencyWeeklyResult.findMany({
    where: { trainerId, studentId: { in: studentIds }, weekStart: { lt: mondayDate } },
    orderBy: { weekStart: 'desc' },
  });
  const byStudent = new Map();
  for (const row of rows) byStudent.set(row.studentId, [...(byStudent.get(row.studentId) ?? []), row]);
  return byStudent;
}

// Season figures of one student from stored closed weeks plus the running week
function summarizeStudent(link, results, week, { season, elapsed, minPodiumWeeks }) {
  const figures = seasonFigures(results, season.id);
  const validWeeks = figures.validWeeks + (week.status === WeekStatus.VALID ? 1 : 0);
  return {
    studentId: link.studentId,
    name: displayName(link.student),
    eligible: isEligible({ validWeeks, elapsedWeeks: elapsed, minPodiumWeeks }),
    average: liveAverage(figures.scores, week.partial),
    validWeeks,
    weeksAt100: figures.weeksAt100,
    streak: figures.streak,
    partialScore: week.partial,
    weekStatus: week.status,
    pillars: week.pillars,
  };
}

// Students still entering the season, with the valid weeks they lack, ordered by name
function enteringList(students, required) {
  return students
    .filter((student) => !student.eligible)
    .map(({ studentId, name, validWeeks }) => ({ studentId, name, validWeeks, weeksMissing: required - validWeeks }))
    .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR', { sensitivity: 'base' }));
}

// Live data of the active season: ranked rows, students still entering (RANK-25 leaves out those without a valid week) and the context the panel fields need, where every active student appears
async function liveData(prisma, trainerId, season, now) {
  const config = await getConfig(prisma, trainerId, now);
  const mondayDate = dbDateOf(weekStartFor(now, config.timeZone));
  const elapsed = elapsedWeeksOf(season, mondayDate);
  const links = await prisma.trainerStudent.findMany({
    where: { trainerId, activeOnPlan: true },
    select: { studentId: true, createdAt: true, student: STUDENT_SELECT },
  });
  if (links.length === 0) {
    const context = { season, config, mondayDate, elapsed, links, results: new Map(), weeks: new Map(), students: [] };
    return { season: summarizeSeason(season, elapsed), rows: [], entering: [], context };
  }

  const ids = links.map((link) => link.studentId);
  const [weeks, results] = await Promise.all([
    evaluateRunningWeek(prisma, trainerId, mondayDate, links),
    readResultsByStudent(prisma, trainerId, ids, mondayDate),
  ]);
  const context = { season, elapsed, minPodiumWeeks: config.minPodiumWeeks };
  const everyone = links.map((link) => summarizeStudent(link, results.get(link.studentId) ?? [], weeks.get(link.studentId), context));
  const students = everyone.filter((student) => student.validWeeks > 0);
  return {
    season: summarizeSeason(season, elapsed),
    rows: rankStandings(students.filter((student) => student.eligible)),
    entering: enteringList(students, Math.min(config.minPodiumWeeks, elapsed)),
    context: { season, config, mondayDate, elapsed, links, results, weeks, students: everyone },
  };
}

// Live standings of the active season: ranked rows plus students still entering
async function liveStandings(prisma, trainerId, season, now) {
  const { season: summary, rows, entering } = await liveData(prisma, trainerId, season, now);
  return { season: summary, rows, entering };
}

// Orders by stored position, then by name for tied students
function byPositionThenName(a, b) {
  if (a.position !== b.position) return (a.position ?? 0) - (b.position ?? 0);
  return a.name.localeCompare(b.name, 'pt-BR', { sensitivity: 'base' });
}

// Frozen data of a closed season, read from the stored snapshot, with every stored row for the panel fields
async function frozenData(prisma, trainerId, season, now) {
  const config = await getConfig(prisma, trainerId, now);
  const required = Math.min(config.minPodiumWeeks, season.weeks);
  const stored = await prisma.consistencySeasonStanding.findMany({
    where: { seasonId: season.id },
    include: { student: STUDENT_SELECT },
    orderBy: { position: 'asc' },
  });
  const named = stored.map((row) => ({ ...row, name: displayName(row.student) })).sort(byPositionThenName);
  const rows = named
    .filter((row) => row.eligible)
    .map((row) => ({
      studentId: row.studentId,
      name: row.name,
      position: row.position,
      eligible: true,
      average: row.average,
      validWeeks: row.validWeeks,
      weeksAt100: row.weeks100,
      streak: row.streak,
    }));
  const entering = named
    .filter((row) => !row.eligible && row.validWeeks > 0)
    .map((row) => ({ studentId: row.studentId, name: row.name, validWeeks: row.validWeeks, weeksMissing: Math.max(required - row.validWeeks, 0) }));
  return { season: summarizeSeason(season, season.weeks), rows, entering, named, required };
}

// Frozen standings of a closed season, read from the stored snapshot
async function frozenStandings(prisma, trainerId, season, now) {
  const { season: summary, rows, entering } = await frozenData(prisma, trainerId, season, now);
  return { season: summary, rows, entering };
}

// Season asked for: the one with that number (404 when absent) or the current one
async function resolveSeason(prisma, trainerId, seasonNumber, now) {
  if (seasonNumber === undefined || seasonNumber === null) return ensureCurrentSeason(prisma, trainerId, now);
  const found = await prisma.consistencySeason.findFirst({ where: { trainerId, number: seasonNumber } });
  if (!found) throw seasonNotFoundError();
  return found;
}

/**
 * Standings of a trainer's team: live for the active season, frozen for a closed one; season is null (empty lists) before any season exists.
 *
 * @param {object} prisma
 * @param {string} trainerId - Trainer.id
 * @param {{ seasonNumber?: number, now?: Date }} [options]
 * @returns {Promise<{ season: object|null, rows: object[], entering: object[] }>}
 */
export async function getStandings(prisma, trainerId, { seasonNumber, now = new Date() } = {}) {
  const season = await resolveSeason(prisma, trainerId, seasonNumber, now);
  if (!season) return { season: null, rows: [], entering: [] };
  if (season.status === SeasonStatus.CLOSED) return frozenStandings(prisma, trainerId, season, now);
  return liveStandings(prisma, trainerId, season, now);
}

const PANEL_FILTER_DEFAULT = StandingsFilter.ALL;

// Number of a Decimal-like value, or null when absent
function numberOrNull(value) {
  return value === null || value === undefined ? null : Number(value);
}

// Panel rules of the config, falling back to the defaults for the ones it does not carry
function panelRulesOf(config) {
  return Object.fromEntries(Object.entries(PANEL_DEFAULTS).map(([rule, fallback]) => [rule, config[rule] ?? fallback]));
}

// Whether the session finished inside the half-open window (from, to]
function finishedWithin(session, { from, to }) {
  const finished = session.finishedAt.getTime();
  return finished > from.getTime() && finished <= to.getTime();
}

// Counting window and close instant of the week starting on the civil Monday
async function weekFrame(prisma, trainerId, weekStart) {
  const previous = civilOf(new Date(dbDateOf(weekStart).getTime() - MS_PER_WEEK));
  const [rule, previousRule] = await Promise.all([
    ruleForWeek(prisma, trainerId, weekStart),
    ruleForWeek(prisma, trainerId, previous),
  ]);
  return { window: doneWindow(weekStart, rule, previousRule), closeInstant: weekBounds(weekStart, rule).closeInstant };
}

// Review signals per student for the running week and the last closed one, plus the close instant of the running week
async function readSignals(prisma, trainerId, studentIds, mondayDate, rules) {
  const current = await weekFrame(prisma, trainerId, civilOf(mondayDate));
  const last = await weekFrame(prisma, trainerId, civilOf(new Date(mondayDate.getTime() - MS_PER_WEEK)));
  const sessions = await listSessions(prisma, trainerId, studentIds, { from: last.window.from, to: current.window.to });
  const byStudent = new Map();
  for (const studentId of studentIds) {
    const own = sessions.filter((session) => session.studentId === studentId);
    byStudent.set(studentId, [
      ...signalsFor(own.filter((session) => finishedWithin(session, last.window)), last.closeInstant, rules),
      ...signalsFor(own.filter((session) => finishedWithin(session, current.window)), current.closeInstant, rules),
    ]);
  }
  return { byStudent, closesAt: current.closeInstant };
}

// Pause of the running week with its reason, or null when the student counts
function pauseOf(student, mondayDate, reasons) {
  if (student.weekStatus !== WeekStatus.PAUSED) return null;
  const reason = reasons.students.has(student.studentId) ? reasons.students.get(student.studentId) : reasons.team;
  return { weekStart: dateKey(mondayDate), reason: reason ?? null };
}

// Newest paused week already closed in the season, or null (results are newest first)
function lastClosedPauseRow(closed, seasonId) {
  return closed.find((result) => result.seasonId === seasonId && result.status === WeekStatus.PAUSED) ?? null;
}

// Reasons of the closed paused weeks, keyed by week start
async function closedPauseReasons(prisma, trainerId, results, seasonId) {
  const rows = [...results.values()].map((closed) => lastClosedPauseRow(closed, seasonId)).filter(Boolean);
  const weeks = new Map(rows.map((row) => [dateKey(row.weekStart), civilOf(row.weekStart)]));
  const entries = await Promise.all([...weeks].map(async ([key, week]) => [key, await pauseReasonsFor(prisma, trainerId, week)]));
  return new Map(entries);
}

// Newest closed paused week of the student with its reason, or null
function closedPauseOf(studentId, closed, seasonId, closedReasons) {
  const row = lastClosedPauseRow(closed, seasonId);
  if (!row) return null;
  const weekStart = dateKey(row.weekStart);
  const reasons = closedReasons.get(weekStart);
  const reason = reasons.students.has(studentId) ? reasons.students.get(studentId) : reasons.team;
  return { weekStart, reason: reason ?? null };
}

// Panel row of one student from the live figures and the panel context
function livePanelRow(student, position, { users, results, reasons, closedReasons, signals, rules, mondayDate, season, required }) {
  const closed = results.get(student.studentId) ?? [];
  const risk = riskFor(closed, rules);
  return {
    studentId: student.studentId,
    name: student.name,
    ...shortNameOf(users.get(student.studentId)),
    position,
    eligible: student.eligible,
    faixa: faixaFor(student.average, student.eligible),
    average: numberOrNull(student.average),
    currentWeekScore: numberOrNull(student.partialScore),
    partialScore: numberOrNull(student.partialScore),
    weekStatus: student.weekStatus,
    pillars: student.pillars,
    validWeeks: student.validWeeks,
    weeks100: student.weeksAt100,
    weeksAt100: student.weeksAt100,
    streak: student.streak,
    seasonPillars: seasonPillars(closed.filter((row) => row.seasonId === season.id)),
    risk: risk.atRisk ? { weeks: risk.scores.length, scores: risk.scores } : null,
    signals: signals.get(student.studentId) ?? [],
    pause: pauseOf(student, mondayDate, reasons),
    closedPause: closedPauseOf(student.studentId, closed, season.id, closedReasons),
    entering: student.eligible ? null : { validWeeks: student.validWeeks, required },
    ...(student.eligible ? {} : { weeksMissing: required - student.validWeeks }),
  };
}

// Stored results of the last closed week of the season, for the team summary
function lastClosedWeekResults(results, season, mondayDate) {
  const lastMonday = mondayDate.getTime() - MS_PER_WEEK;
  return [...results.values()].flat().filter((row) => row.seasonId === season.id && row.weekStart.getTime() === lastMonday);
}

// Panel rows, last closed week results and close instant of the live season
async function livePanelData(prisma, trainerId, data) {
  const { season, config, mondayDate, elapsed, results, students } = data.context;
  const rules = panelRulesOf(config);
  const ids = students.map((student) => student.studentId);
  const [{ byStudent, closesAt }, reasons, closedReasons] = await Promise.all([
    readSignals(prisma, trainerId, ids, mondayDate, rules),
    pauseReasonsFor(prisma, trainerId, civilOf(mondayDate)),
    closedPauseReasons(prisma, trainerId, results, season.id),
  ]);
  const shared = {
    users: new Map(data.context.links.map((link) => [link.studentId, link.student])),
    results,
    reasons,
    closedReasons,
    signals: byStudent,
    rules,
    mondayDate,
    season,
    required: Math.min(config.minPodiumWeeks, elapsed),
  };
  const positions = new Map(data.rows.map((row) => [row.studentId, row.position]));
  const rows = students.map((student) => livePanelRow(student, positions.get(student.studentId) ?? null, shared));
  return { rows, lastClosed: lastClosedWeekResults(results, season, mondayDate), closesAt };
}

// Season pillars of each student from the stored weeks of a closed season
async function frozenSeasonPillars(prisma, trainerId, seasonId) {
  const results = await prisma.consistencyWeeklyResult.findMany({ where: { trainerId, seasonId } });
  const byStudent = new Map();
  for (const result of results) byStudent.set(result.studentId, [...(byStudent.get(result.studentId) ?? []), result]);
  return new Map([...byStudent].map(([studentId, closed]) => [studentId, seasonPillars(closed)]));
}

// Panel row of one frozen standing: a closed season has no risk, signals or pause
function frozenPanelRow(row, required, pillars) {
  return {
    studentId: row.studentId,
    name: row.name,
    ...shortNameOf(row.student),
    position: row.eligible ? row.position : null,
    eligible: row.eligible,
    faixa: faixaFor(row.average, row.eligible),
    average: numberOrNull(row.average),
    currentWeekScore: null,
    validWeeks: row.validWeeks,
    weeks100: row.weeks100,
    weeksAt100: row.weeks100,
    streak: row.streak,
    seasonPillars: pillars.get(row.studentId) ?? [],
    risk: null,
    signals: [],
    pause: null,
    closedPause: null,
    entering: row.eligible ? null : { validWeeks: row.validWeeks, required },
    ...(row.eligible ? {} : { weeksMissing: Math.max(required - row.validWeeks, 0) }),
  };
}

// Applies the filter, the search and the order, and splits ranked rows from students still entering
function assemblePanel(season, rows, { filter, q }, lastClosed) {
  const visible = sortForFilter(searchStandings(filterStandings(rows, filter), q), filter);
  return {
    season,
    summary: teamSummary(rows, lastClosed),
    counts: countFilters(rows),
    rows: visible.filter((row) => row.entering === null),
    entering: visible.filter((row) => row.entering !== null),
  };
}

/**
 * Standings for the trainer panel: live or frozen rows with band, season pillars, risk, signals, pause and entering progress, filtered, searched and ordered, plus the filter counts and the team summary.
 *
 * @param {object} prisma
 * @param {string} trainerId - Trainer.id
 * @param {{ seasonNumber?: number, filter?: string, q?: string, now?: Date }} [options]
 * @returns {Promise<{ season: object|null, summary: object, counts: object, rows: object[], entering: object[], notStarted: { reason: string, startsOn: string|null }|null }>}
 */
export async function getPanelStandings(prisma, trainerId, { seasonNumber, filter = PANEL_FILTER_DEFAULT, q, now = new Date() } = {}) {
  const season = await resolveSeason(prisma, trainerId, seasonNumber, now);
  if (!season) {
    const notStarted = await seasonNotStartedReason(prisma, trainerId, now);
    return { ...assemblePanel(null, [], { filter, q }, []), notStarted };
  }
  if (season.status === SeasonStatus.CLOSED) {
    const frozen = await frozenData(prisma, trainerId, season, now);
    const pillars = await frozenSeasonPillars(prisma, trainerId, season.id);
    const rows = frozen.named.filter((row) => row.eligible || row.validWeeks > 0).map((row) => frozenPanelRow(row, frozen.required, pillars));
    return { ...assemblePanel({ ...frozen.season, closesAt: null }, rows, { filter, q }, []), notStarted: null };
  }
  const data = await liveData(prisma, trainerId, season, now);
  const { rows, lastClosed, closesAt } = await livePanelData(prisma, trainerId, data);
  return { ...assemblePanel({ ...data.season, closesAt }, rows, { filter, q }, lastClosed), notStarted: null };
}
