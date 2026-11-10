import { NotFoundAppError } from '../errors/app-error.js';

const STUDENT_NOT_FOUND = 'student.notFound';

// Throws 404 student.notFound unless the student is linked to the trainer
async function assertStudentOfTrainer(prisma, trainerId, studentId) {
  const link = await prisma.trainerStudent.findFirst({ where: { trainerId, studentId }, select: { id: true } });
  if (!link) {
    throw new NotFoundAppError({ message: 'Student not found', messageCode: STUDENT_NOT_FOUND });
  }
}

/**
 * Logs one use of "open on WhatsApp" for a student of the trainer; every use is kept.
 *
 * @param {object} prisma
 * @param {string} trainerId - Trainer.id
 * @param {string} studentId - User.id; 404 when the student is not linked to the trainer
 * @param {string|undefined} pillar - weakest pillar the message was about
 * @param {Date} [now]
 * @returns {Promise<{ studentId: string, pillar: string|null, createdAt: Date }>}
 */
export async function logContact(prisma, trainerId, studentId, pillar, now = new Date()) {
  await assertStudentOfTrainer(prisma, trainerId, studentId);
  const created = await prisma.consistencyContactLog.create({
    data: { trainerId, studentId, pillar: pillar ?? null, createdAt: now },
  });
  return { studentId: created.studentId, pillar: created.pillar, createdAt: created.createdAt };
}

/**
 * Date of the last time the trainer opened WhatsApp for the student.
 *
 * @param {object} prisma
 * @param {string} trainerId - Trainer.id
 * @param {string} studentId - User.id
 * @returns {Promise<Date|null>}
 */
export async function lastContact(prisma, trainerId, studentId) {
  const last = await prisma.consistencyContactLog.findFirst({
    where: { trainerId, studentId },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  });
  return last?.createdAt ?? null;
}
