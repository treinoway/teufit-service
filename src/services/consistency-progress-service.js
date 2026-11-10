import { CATEGORY_TO_PILLAR, Pillar } from '../constants/consistency-ranking.js';
import { TrainingCategory, WorkoutSessionStatus } from '../constants/training.js';

// Completed sessions grouped by student and training category inside (from, to]
function queryDoneRows(prisma, trainerId, studentIds, { from, to }) {
  return prisma.$queryRaw`
    SELECT ws.user_id AS student_id, t.category AS category, COUNT(*) AS total
    FROM workout_sessions ws
    JOIN trainings t ON t.id = ws.training_id
    JOIN training_protocols tp ON tp.id = t.training_protocol_id
    WHERE ws.user_id = ANY(${studentIds}::uuid[])
      AND ws.status = ${WorkoutSessionStatus.COMPLETED}
      AND ws.deleted_at IS NULL
      AND ws.finished_at > ${from}
      AND ws.finished_at <= ${to}
      AND tp.trainer_id = ${trainerId}::uuid
    GROUP BY ws.user_id, t.category
  `;
}

// Counts the completed sessions of each student per pillar in the window (from, to]
export async function countDone(prisma, trainerId, studentIds, window) {
  const result = new Map();
  if (studentIds.length === 0) return result;
  for (const id of studentIds) result.set(id, { workouts: 0, cardio: 0 });
  const rows = await queryDoneRows(prisma, trainerId, studentIds, window);
  for (const row of rows) {
    const pillar = CATEGORY_TO_PILLAR[row.category];
    const counts = result.get(row.student_id);
    if (pillar === Pillar.WORKOUTS) counts.workouts += Number(row.total);
    if (pillar === Pillar.CARDIO) counts.cardio += Number(row.total);
  }
  return result;
}

// Completed sessions of the students inside (from, to] with their duration, rest trainings left out
function querySessionRows(prisma, trainerId, studentIds, { from, to }) {
  return prisma.$queryRaw`
    SELECT ws.id AS id, ws.user_id AS student_id, ws.finished_at AS finished_at, ws.duration_seconds AS duration_seconds
    FROM workout_sessions ws
    JOIN trainings t ON t.id = ws.training_id
    JOIN training_protocols tp ON tp.id = t.training_protocol_id
    WHERE ws.user_id = ANY(${studentIds}::uuid[])
      AND ws.status = ${WorkoutSessionStatus.COMPLETED}
      AND ws.deleted_at IS NULL
      AND ws.finished_at > ${from}
      AND ws.finished_at <= ${to}
      AND t.category <> ${TrainingCategory.REST}
      AND tp.trainer_id = ${trainerId}::uuid
    ORDER BY ws.finished_at
  `;
}

/**
 * Completed sessions of the students inside (from, to], the input of the review signals.
 *
 * @param {object} prisma
 * @param {string} trainerId
 * @param {string[]} studentIds
 * @param {{ from: Date, to: Date }} window
 * @returns {Promise<Array<{ id: string, studentId: string, finishedAt: Date, durationSeconds: number|null }>>}
 */
export async function listSessions(prisma, trainerId, studentIds, window) {
  if (studentIds.length === 0) return [];
  const rows = await querySessionRows(prisma, trainerId, studentIds, window);
  return rows.map((row) => ({
    id: row.id,
    studentId: row.student_id,
    finishedAt: row.finished_at,
    durationSeconds: row.duration_seconds,
  }));
}
