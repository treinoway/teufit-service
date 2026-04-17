import { prisma } from '../db.js';

const REQUIRED_USER_FIELDS = ['firstName', 'lastName', 'birthDate', 'gender'];
const REQUIRED_ADDRESS_FIELDS = ['line1', 'city', 'state', 'postalCode', 'country'];

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
 * Returns true when all nine required personal + address fields are filled.
 *
 * @param {{ user: object, address: object|null }} params
 */
export function isProfileDataComplete({ user, address }) {
  if (!user || !address) return false;

  const allUserFieldsFilled = REQUIRED_USER_FIELDS.every((field) =>
    isFieldFilled(user[field]),
  );

  const allAddressFieldsFilled = REQUIRED_ADDRESS_FIELDS.every((field) =>
    isFieldFilled(address[field]),
  );

  return allUserFieldsFilled && allAddressFieldsFilled;
}

/**
 * Mark profileCompletedAt on the Trainer row if:
 *   - The user has a Trainer record.
 *   - profileCompletedAt is still null.
 *   - All nine required profile fields are present and non-empty.
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
          birthDate: true,
          gender: true,
        },
      },
    },
  });

  if (!trainer || trainer.profileCompletedAt !== null) return;

  const address = await db.address.findUnique({
    where: { userId },
    select: {
      line1: true,
      city: true,
      state: true,
      postalCode: true,
      country: true,
    },
  });

  if (!isProfileDataComplete({ user: trainer.user, address })) return;

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
