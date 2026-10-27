import { prisma } from '../db.js';

const REQUIRED_USER_FIELDS = ['firstName', 'lastName', 'avatarUrl'];

/**
 * Check whether a field value counts as "filled in".
 * Null, undefined, and empty / blank strings are treated as absent.
 */
function isFieldFilled(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  return true;
}

/**
 * Returns true when the user has first name, last name and avatar filled in.
 *
 * @param {{ user: object|null }} params
 */
export function isProfileDataComplete({ user }) {
  if (!user) return false;

  return REQUIRED_USER_FIELDS.every((field) => isFieldFilled(user[field]));
}

/**
 * Mark profileCompletedAt on the Trainer row if:
 *   - The user has a Trainer record.
 *   - profileCompletedAt is still null.
 *   - First name, last name and avatar are present and non-empty.
 *
 * Idempotent and safe to call from inside or outside a transaction.
 *
 * @param {{ userId: string, tx?: import('@prisma/client').PrismaClient }} params
 */
export async function maybeMarkProfileComplete({ userId, tx }) {
  const db = tx ?? prisma;

  const trainer = await db.trainer.findUnique({
    where: { userId },
    select: {
      id: true,
      profileCompletedAt: true,
      user: {
        select: {
          firstName: true,
          lastName: true,
          avatarUrl: true,
        },
      },
    },
  });

  if (!trainer || trainer.profileCompletedAt !== null) return;
  if (!isProfileDataComplete({ user: trainer.user })) return;

  await db.trainer.updateMany({
    where: { id: trainer.id, profileCompletedAt: null },
    data: { profileCompletedAt: new Date() },
  });
}

/**
 * Mark firstStudentLinkedAt on the Trainer row if it is still null.
 * Uses updateMany with a where-null guard to be race-condition safe.
 *
 * @param {{ trainerId: string, tx?: import('@prisma/client').PrismaClient }} params
 */
export async function maybeMarkFirstStudentLinked({ trainerId, tx }) {
  const db = tx ?? prisma;

  await db.trainer.updateMany({
    where: { id: trainerId, firstStudentLinkedAt: null },
    data: { firstStudentLinkedAt: new Date() },
  });
}

/**
 * Mark firstProtocolCreatedAt on the Trainer row if it is still null.
 * Uses updateMany with a where-null guard to be race-condition safe.
 *
 * @param {{ trainerId: string, tx?: import('@prisma/client').PrismaClient }} params
 */
export async function maybeMarkFirstProtocolCreated({ trainerId, tx }) {
  const db = tx ?? prisma;

  await db.trainer.updateMany({
    where: { id: trainerId, firstProtocolCreatedAt: null },
    data: { firstProtocolCreatedAt: new Date() },
  });
}

// Sets a Trainer milestone column once, guarded by a where-null clause.
async function markMilestoneOnce({ trainerId, tx, column }) {
  const db = tx ?? prisma;

  await db.trainer.updateMany({
    where: { id: trainerId, [column]: null },
    data: { [column]: new Date() },
  });
}

/**
 * Mark firstStudentInvitedAt on the Trainer row if it is still null.
 *
 * @param {{ trainerId: string, tx?: import('@prisma/client').PrismaClient }} params
 */
export function maybeMarkFirstStudentInvited({ trainerId, tx }) {
  return markMilestoneOnce({ trainerId, tx, column: 'firstStudentInvitedAt' });
}

/**
 * Mark firstAnamnesisSentAt on the Trainer row if it is still null.
 *
 * @param {{ trainerId: string, tx?: import('@prisma/client').PrismaClient }} params
 */
export function maybeMarkFirstAnamnesisSent({ trainerId, tx }) {
  return markMilestoneOnce({ trainerId, tx, column: 'firstAnamnesisSentAt' });
}

/**
 * Mark brandingConfiguredAt on the Trainer row if it is still null.
 *
 * @param {{ trainerId: string, tx?: import('@prisma/client').PrismaClient }} params
 */
export function maybeMarkBrandingConfigured({ trainerId, tx }) {
  return markMilestoneOnce({ trainerId, tx, column: 'brandingConfiguredAt' });
}
