import { Pillar } from '../constants/consistency-ranking.js';
import { TrainingStatus } from '../constants/training.js';
import { expectedFromProtocols, weekBounds } from '../helpers/consistency-week.js';
import { ruleForWeek } from './consistency-config-service.js';

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
    byStudent.set(row.studentId, { ...byStudent.get(row.studentId), [row.pillar]: row.expected });
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
