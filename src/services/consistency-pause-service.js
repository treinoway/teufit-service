import { AppError, NotFoundAppError } from '../errors/app-error.js';
import { ConsistencyErrorCode, ConsistencyMessageCode, MAX_PAUSE_WEEKS_AHEAD } from '../constants/consistency-ranking.js';
import { weekBounds, weekStartFor } from '../helpers/consistency-week.js';
import { ruleForWeek } from './consistency-config-service.js';

const DAYS_IN_WEEK = 7;
const MS_PER_DAY = 86400000;
const UNIQUE_VIOLATION = 'P2002';
const STUDENT_NOT_FOUND = 'student.notFound';

// Midnight-UTC Date of a civil date, the shape of a @db.Date column
function toDbDate({ year, month, day }) {
  return new Date(Date.UTC(year, month - 1, day));
}

// "YYYY-MM-DD" key of a civil date
function weekKey({ year, month, day }) {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// Civil date of a @db.Date value
function fromDbDate(date) {
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

// Whole weeks from the first civil Monday to the second
function weeksBetween(from, to) {
  return Math.round((toDbDate(to).getTime() - toDbDate(from).getTime()) / (MS_PER_DAY * DAYS_IN_WEEK));
}

// 409 for a week that can no longer (or not yet) be changed
function weekNotEditableError(weekStart) {
  return new AppError({
    httpStatus: 409,
    error: ConsistencyErrorCode.PAUSE_WEEK_NOT_EDITABLE,
    messageCode: ConsistencyMessageCode.PAUSE_WEEK_NOT_EDITABLE,
    message: 'This week can no longer be paused or resumed',
    details: { weekStart: weekKey(weekStart) },
  });
}

// Throws 409 unless the week is open: not closed yet and at most MAX_PAUSE_WEEKS_AHEAD weeks after the current one
async function assertWeekEditable(prisma, trainerId, weekStart, now) {
  const rule = await ruleForWeek(prisma, trainerId, weekStart);
  const tooFar = weeksBetween(weekStartFor(now, rule.timeZone), weekStart) > MAX_PAUSE_WEEKS_AHEAD;
  const pastClose = weekBounds(weekStart, rule).closeInstant.getTime() <= now.getTime();
  if (tooFar || pastClose) throw weekNotEditableError(weekStart);
  const closeMark = await prisma.consistencyWeekClose.findFirst({ where: { trainerId, weekStart: toDbDate(weekStart) } });
  if (closeMark) throw weekNotEditableError(weekStart);
}

// Throws 404 student.notFound unless the student is linked to the trainer
async function assertStudentOfTrainer(prisma, trainerId, studentId) {
  const link = await prisma.trainerStudent.findFirst({ where: { trainerId, studentId }, select: { id: true } });
  if (!link) {
    throw new NotFoundAppError({ message: 'Student not found', messageCode: STUDENT_NOT_FOUND });
  }
}

// Validates the target (student link, week editable) before any write
async function assertEditable(prisma, trainerId, weekStart, studentId, now) {
  if (studentId) await assertStudentOfTrainer(prisma, trainerId, studentId);
  await assertWeekEditable(prisma, trainerId, weekStart, now);
}

// Updates the row of (trainer, student|team, week); creates it when absent, tolerating a concurrent insert
async function writePauseRow(prisma, { trainerId, studentId, weekDate, paused, reason }) {
  const where = { trainerId, studentId, weekStart: weekDate };
  const data = reason === undefined ? { paused } : { paused, reason };
  if ((await prisma.consistencyWeekPause.updateMany({ where, data })).count > 0) return;
  try {
    await prisma.consistencyWeekPause.create({ data: { ...where, paused, reason: reason ?? null } });
  } catch (error) {
    if (error?.code !== UNIQUE_VIOLATION) throw error;
    await prisma.consistencyWeekPause.updateMany({ where, data });
  }
}

/**
 * Pauses the week of one student, or of the whole team when no studentId is given (idempotent).
 *
 * @param {object} prisma
 * @param {string} trainerId - Trainer.id
 * @param {{ weekStart: { year: number, month: number, day: number }, studentId?: string, reason?: string }} input - weekStart is the civil Monday
 * @param {Date} now
 * @returns {Promise<{ weekStart: string, studentId: string|null, paused: true, reason: string|null }>}
 */
export async function pauseWeek(prisma, trainerId, { weekStart, studentId = null, reason }, now = new Date()) {
  await assertEditable(prisma, trainerId, weekStart, studentId, now);
  const weekDate = toDbDate(weekStart);
  await writePauseRow(prisma, { trainerId, studentId, weekDate, paused: true, reason: reason ?? null });
  if (!studentId) {
    await prisma.consistencyWeekPause.deleteMany({ where: { trainerId, studentId: { not: null }, weekStart: weekDate, paused: false } });
  }
  return { weekStart: weekKey(weekStart), studentId, paused: true, reason: reason ?? null };
}

// Resumes one student: an exception row inside a team pause, otherwise drops the own pause row
async function resumeStudent(prisma, trainerId, studentId, weekDate) {
  const teamPause = await prisma.consistencyWeekPause.findFirst({ where: { trainerId, studentId: null, weekStart: weekDate, paused: true } });
  if (teamPause) {
    await writePauseRow(prisma, { trainerId, studentId, weekDate, paused: false });
    return;
  }
  await prisma.consistencyWeekPause.deleteMany({ where: { trainerId, studentId, weekStart: weekDate } });
}

/**
 * Resumes the week of one student (exception inside a team pause) or of the whole team (drops every pause row of the week).
 *
 * @param {object} prisma
 * @param {string} trainerId - Trainer.id
 * @param {{ weekStart: { year: number, month: number, day: number }, studentId?: string }} input - weekStart is the civil Monday
 * @param {Date} now
 * @returns {Promise<{ weekStart: string, studentId: string|null, paused: false }>}
 */
export async function resumeWeek(prisma, trainerId, { weekStart, studentId = null }, now = new Date()) {
  await assertEditable(prisma, trainerId, weekStart, studentId, now);
  const weekDate = toDbDate(weekStart);
  if (studentId) {
    await resumeStudent(prisma, trainerId, studentId, weekDate);
  } else {
    await prisma.consistencyWeekPause.deleteMany({ where: { trainerId, weekStart: weekDate } });
  }
  return { weekStart: weekKey(weekStart), studentId, paused: false };
}

/**
 * Pause state of the given weeks: the team flag and the per-student rows (true paused, false reactivated).
 *
 * @param {object} prisma
 * @param {string} trainerId - Trainer.id
 * @param {Array<{ year: number, month: number, day: number }>} weekStarts - civil Mondays
 * @returns {Promise<Map<string, { team: boolean, students: Map<string, boolean> }>>}
 */
export async function pausesFor(prisma, trainerId, weekStarts) {
  const result = new Map(weekStarts.map((weekStart) => [weekKey(weekStart), { team: false, students: new Map() }]));
  if (weekStarts.length === 0) return result;
  const rows = await prisma.consistencyWeekPause.findMany({ where: { trainerId, weekStart: { in: weekStarts.map(toDbDate) } } });
  for (const row of rows) {
    const entry = result.get(weekKey(fromDbDate(row.weekStart)));
    if (!entry) continue;
    if (row.studentId === null) entry.team = row.paused;
    else entry.students.set(row.studentId, row.paused);
  }
  return result;
}

/**
 * Reasons of the paused rows of one week: the team pause and each paused student (null when no reason was typed).
 *
 * @param {object} prisma
 * @param {string} trainerId - Trainer.id
 * @param {{ year: number, month: number, day: number }} weekStart - civil Monday
 * @returns {Promise<{ team: string|null, students: Map<string, string|null> }>}
 */
export async function pauseReasonsFor(prisma, trainerId, weekStart) {
  const rows = await prisma.consistencyWeekPause.findMany({ where: { trainerId, weekStart: toDbDate(weekStart), paused: true } });
  const reasons = { team: null, students: new Map() };
  for (const row of rows) {
    if (row.studentId === null) reasons.team = row.reason ?? null;
    else reasons.students.set(row.studentId, row.reason ?? null);
  }
  return reasons;
}
