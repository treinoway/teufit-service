import { CATEGORY_TO_PILLAR, Pillar } from '../constants/consistency-ranking.js';
import { WorkoutSessionStatus } from '../constants/training.js';

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
