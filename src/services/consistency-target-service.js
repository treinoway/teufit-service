import { AppError } from '../errors/app-error.js';
import { ConsistencyErrorCode, ConsistencyMessageCode, Pillar } from '../constants/consistency-ranking.js';
import { TrainingStatus } from '../constants/training.js';
import { formatDateOnly } from '../helpers/date-helpers.js';
import { expectedFromProtocols, weekBounds, weekStartFor } from '../helpers/consistency-week.js';
import { getConfig, ruleForWeek } from './consistency-config-service.js';
import { assertStudentOfTrainer } from './consistency-student-access.js';

const TARGET_PILLARS = Object.freeze([Pillar.WORKOUTS, Pillar.CARDIO]);

// Midnight-UTC date matching @db.Date columns for a civil date
function civilToDate({ year, month, day }) {
  return new Date(Date.UTC(year, month - 1, day));
}

// Expected counts from stored pillar rows, zero when a pillar is missing
function toExpected(rows) {
  return { workouts: rows[Pillar.WORKOUTS] ?? 0, cardio: rows[Pillar.CARDIO] ?? 0 };
}

// Stored targets of the week grouped by student and pillar
async function readStoredTargets(prisma, trainerId, weekStart, studentIds) {
  const rows = await prisma.consistencyWeeklyTarget.findMany({
    where: { trainerId, studentId: { in: studentIds }, weekStart: civilToDate(weekStart) },
  });
  const byStudent = new Map();
  for (const row of rows) {
    byStudent.set(row.studentId, { ...byStudent.get(row.studentId), [row.pillar]: row.adjusted ?? row.expected });
  }
  return byStudent;
}

// Protocols and trainings as they existed at the instant, grouped by student
async function readPlanAsOf(prisma, trainerId, studentIds, { instant, firstDay, lastDay }) {
  const protocols = await prisma.trainingProtocol.findMany({
    where: {
      trainerId,
      assigneeId: { in: studentIds },
      status: TrainingStatus.ACTIVE,
      createdAt: { lte: instant },
      startDate: { lte: lastDay },
      AND: [
        { OR: [{ deletedAt: null }, { deletedAt: { gt: instant } }] },
        { OR: [{ expirationDate: null }, { expirationDate: { gte: firstDay } }] },
      ],
    },
    select: {
      assigneeId: true,
      startDate: true,
      expirationDate: true,
      trainings: {
        where: {
          createdAt: { lte: instant },
          OR: [{ deletedAt: null }, { deletedAt: { gt: instant } }],
        },
        select: { weekDay: true, category: true },
      },
    },
  });
  const byStudent = new Map();
  for (const protocol of protocols) {
    byStudent.set(protocol.assigneeId, [...(byStudent.get(protocol.assigneeId) ?? []), protocol]);
  }
  return byStudent;
}

// One target row per pillar (zeros included) for a student
function targetRows(trainerId, studentId, weekStart, expected) {
  return TARGET_PILLARS.map((pillar) => ({
    trainerId,
    studentId,
    weekStart: civilToDate(weekStart),
    pillar,
    expected: expected[pillar],
  }));
}

// Computes and stores the missing students' targets from the plan at Monday 00:00; never overwrites
async function storeMissingTargets(prisma, trainerId, weekStart, missing) {
  const rule = await ruleForWeek(prisma, trainerId, weekStart);
  const { startInstant, scheduleDays } = weekBounds(weekStart, rule);
  const plans = await readPlanAsOf(prisma, trainerId, missing, {
    instant: startInstant,
    firstDay: civilToDate(scheduleDays[0]),
    lastDay: civilToDate(scheduleDays[scheduleDays.length - 1]),
  });
  const rows = missing.flatMap((studentId) =>
    targetRows(trainerId, studentId, weekStart, expectedFromProtocols(plans.get(studentId) ?? [], scheduleDays)),
  );
  await prisma.consistencyWeeklyTarget.createMany({ data: rows, skipDuplicates: true });
}

/**
 * Weekly expected sessions per student and pillar, frozen at the week's Monday 00:00 in the trainer's timezone (RANK-01).
 *
 * @param {object} prisma
 * @param {string} trainerId
 * @param {{ year: number, month: number, day: number }} weekStart - civil Monday
 * @param {string[]} studentIds
 * @returns {Promise<Map<string, { workouts: number, cardio: number }>>}
 */
export async function materializeTargets(prisma, trainerId, weekStart, studentIds) {
  const result = new Map();
  if (studentIds.length === 0) return result;

  const stored = await readStoredTargets(prisma, trainerId, weekStart, studentIds);
  const missing = studentIds.filter((studentId) => !stored.has(studentId));
  if (missing.length > 0) await storeMissingTargets(prisma, trainerId, weekStart, missing);

  const final = missing.length > 0 ? await readStoredTargets(prisma, trainerId, weekStart, studentIds) : stored;
  for (const studentId of studentIds) result.set(studentId, toExpected(final.get(studentId) ?? {}));
  return result;
}

// 409 for a target that cannot be set to the value: closed week, pillar without target or value outside 0..frozen target
function targetNotEditableError(details) {
  return new AppError({
    httpStatus: 409,
    error: ConsistencyErrorCode.TARGET_NOT_EDITABLE,
    messageCode: ConsistencyMessageCode.TARGET_NOT_EDITABLE,
    message: 'This target cannot be adjusted to that value',
    details,
  });
}

// Throws 409 once the week has passed its close instant or has a closed-week mark
async function assertWeekOpen(prisma, trainerId, weekStart, now) {
  const rule = await ruleForWeek(prisma, trainerId, weekStart);
  const pastClose = weekBounds(weekStart, rule).closeInstant.getTime() <= now.getTime();
  const closeMark = pastClose ? null : await prisma.consistencyWeekClose.findFirst({ where: { trainerId, weekStart: civilToDate(weekStart) } });
  if (pastClose || closeMark) throw targetNotEditableError({ weekStart: formatDateOnly(civilToDate(weekStart)) });
}

/**
 * Lowers the target of one pillar for the running week only, from 0 up to the frozen target (PAN-33, PAN-34).
 *
 * @param {object} prisma
 * @param {string} trainerId - Trainer.id
 * @param {string} studentId - User.id; 404 when not linked to the trainer
 * @param {{ pillar: string, value: number }} adjustment
 * @param {Date} [now]
 * @returns {Promise<{ weekStart: string, pillar: string, expected: number, adjusted: number }>} 409 when the week is closed, the pillar has no target or the value is out of range
 */
export async function adjustTarget(prisma, trainerId, studentId, { pillar, value }, now = new Date()) {
  await assertStudentOfTrainer(prisma, trainerId, studentId);
  const config = await getConfig(prisma, trainerId, now);
  const weekStart = weekStartFor(now, config.timeZone);
  if (!TARGET_PILLARS.includes(pillar)) throw targetNotEditableError({ pillar });
  await assertWeekOpen(prisma, trainerId, weekStart, now);
  await materializeTargets(prisma, trainerId, weekStart, [studentId]);
  const row = await prisma.consistencyWeeklyTarget.findFirst({
    where: { trainerId, studentId, weekStart: civilToDate(weekStart), pillar },
  });
  if (!row || !Number.isInteger(value) || value < 0 || value > row.expected) {
    throw targetNotEditableError({ pillar, value, expected: row?.expected ?? null });
  }
  await prisma.consistencyWeeklyTarget.update({ where: { id: row.id }, data: { adjusted: value, adjustedAt: now } });
  return { weekStart: formatDateOnly(civilToDate(weekStart)), pillar, expected: row.expected, adjusted: value };
}
