import { NotFoundAppError } from '../errors/app-error.js';

const STUDENT_NOT_FOUND = 'student.notFound';

/**
 * Throws 404 student.notFound unless the student is linked to the trainer (the 404 hides students of other trainers).
 *
 * @param {object} prisma
 * @param {string} trainerId - Trainer.id
 * @param {string} studentId - User.id
 * @returns {Promise<void>}
 */
export async function assertStudentOfTrainer(prisma, trainerId, studentId) {
  const link = await prisma.trainerStudent.findFirst({ where: { trainerId, studentId }, select: { id: true } });
  if (!link) {
    throw new NotFoundAppError({ message: 'Student not found', messageCode: STUDENT_NOT_FOUND });
  }
}
