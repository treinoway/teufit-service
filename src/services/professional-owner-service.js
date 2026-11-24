import { AppError } from '../errors/app-error.js';
import { SubscriptionErrorCode, SubscriptionMessageCode } from '../constants/subscription.js';

const NOT_FOUND = 404;

// Loads the trainer row id of a user, or null.
async function findTrainerId(prisma, userId) {
  const trainer = await prisma.trainer.findUnique({ where: { userId }, select: { id: true } });
  return trainer?.id ?? null;
}

// Loads the live (not soft-deleted) nutritionist row id of a user, or null.
async function findNutritionistId(prisma, userId) {
  const nutritionist = await prisma.nutritionist.findFirst({
    where: { userId, deletedAt: null },
    select: { id: true },
  });
  return nutritionist?.id ?? null;
}

/**
 * Owner of the billing rows reachable through /trainer/*: the user's trainer row only.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string} userId
 * @returns {Promise<{ userId: string, trainerId: string, nutritionistId: null }>}
 * @throws {AppError} 404 trainer.notFound
 */
export async function resolveTrainerOwnerOrThrow(prisma, userId) {
  const trainerId = await findTrainerId(prisma, userId);

  if (!trainerId) {
    throw new AppError({
      httpStatus: NOT_FOUND,
      error: SubscriptionErrorCode.TRAINER_NOT_FOUND,
      messageCode: SubscriptionMessageCode.TRAINER_NOT_FOUND,
      message: 'Trainer profile not found',
    });
  }

  return { userId, trainerId, nutritionistId: null };
}

/**
 * Owner of the billing rows reachable through /professional/*: every professional row the user holds.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string} userId
 * @returns {Promise<{ userId: string, trainerId: string|null, nutritionistId: string|null }>}
 * @throws {AppError} 404 professional.notFound when the user has neither row
 */
export async function resolveProfessionalOwnerOrThrow(prisma, userId) {
  const [trainerId, nutritionistId] = await Promise.all([
    findTrainerId(prisma, userId),
    findNutritionistId(prisma, userId),
  ]);

  if (!trainerId && !nutritionistId) {
    throw new AppError({
      httpStatus: NOT_FOUND,
      error: SubscriptionErrorCode.PROFESSIONAL_NOT_FOUND,
      messageCode: SubscriptionMessageCode.PROFESSIONAL_NOT_FOUND,
      message: 'Professional profile not found',
    });
  }

  return { userId, trainerId, nutritionistId };
}

/**
 * Owner of a user without requiring a row: used inside unlink transactions where either row may be absent.
 *
 * @param {import('@prisma/client').PrismaClient | import('@prisma/client').Prisma.TransactionClient} client
 * @param {string} userId
 * @param {{ trainerId?: string|null, nutritionistId?: string|null }} [known] rows already resolved, not looked up again
 * @returns {Promise<{ userId: string, trainerId: string|null, nutritionistId: string|null }>}
 */
export async function resolveOwnerRows(client, userId, known = {}) {
  const [trainerId, nutritionistId] = await Promise.all([
    known.trainerId ?? findTrainerId(client, userId),
    known.nutritionistId ?? findNutritionistId(client, userId),
  ]);
  return { userId, trainerId, nutritionistId };
}

/**
 * Reads which of the owner's professional links with the person are live.
 *
 * @param {import('@prisma/client').PrismaClient | import('@prisma/client').Prisma.TransactionClient} client
 * @param {{ trainerId: string|null, nutritionistId: string|null }} owner
 * @param {string} studentId
 * @returns {Promise<{ trainerLinked: boolean, patientLinked: boolean }>}
 */
export async function loadLinks(client, owner, studentId) {
  const trainerLink = owner.trainerId
    ? await client.trainerStudent.findFirst({ where: { trainerId: owner.trainerId, studentId } })
    : null;
  const patientLink = owner.nutritionistId
    ? await client.nutritionistPatient.findFirst({
      where: { nutritionistId: owner.nutritionistId, patientId: studentId, deletedAt: null },
    })
    : null;
  return { trainerLinked: Boolean(trainerLink), patientLinked: Boolean(patientLink) };
}
