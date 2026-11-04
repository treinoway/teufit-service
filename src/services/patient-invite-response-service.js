import s3BucketHandler from '../config/s3-bucket-handler.js';
import { isUserEmailVerified } from './email-verification-service.js';
import { AppError, NotFoundAppError } from '../errors/app-error.js';
import {
  NutritionErrorCode,
  NutritionMessageCode,
  PatientInviteStatus,
  PatientLinkStatus,
} from '../constants/nutrition.js';

// Lowercases and trims an email.
function normalizeEmail(email) {
  if (typeof email !== 'string') return '';
  return email.trim().toLowerCase();
}

// Lowercased email of an active user with a verified email, or null.
async function findPatientEmail(prisma, patientId) {
  if (!(await isUserEmailVerified(prisma, patientId))) return null;
  const user = await prisma.user.findUnique({ where: { id: patientId }, select: { email: true, deletedAt: true } });
  if (!user || user.deletedAt) return null;
  return normalizeEmail(user.email) || null;
}

// Maps an invite row to the patient-facing item (names are never null: empty string; avatar resolved to a URL).
async function toPatientInviteItem(invite) {
  const { firstName, lastName, avatarUrl } = invite.nutritionist.user;
  return {
    id: invite.id,
    nutritionist: { firstName: firstName ?? '', lastName: lastName ?? '', avatarUrl: await s3BucketHandler.resolveUrl(avatarUrl) },
    createdAt: invite.createdAt,
    expiresAt: invite.expiresAt,
  };
}

/**
 * Pending, unexpired nutritionist invites addressed to the patient's email.
 */
export async function listInvitesForPatient(prisma, { patientId }) {
  const email = await findPatientEmail(prisma, patientId);
  if (!email) return { items: [] };
  const invites = await prisma.patientInvite.findMany({
    where: { email, status: PatientInviteStatus.PENDING, expiresAt: { gt: new Date() }, nutritionist: { deletedAt: null } },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      createdAt: true,
      expiresAt: true,
      nutritionist: { select: { user: { select: { firstName: true, lastName: true, avatarUrl: true } } } },
    },
  });
  return { items: await Promise.all(invites.map(toPatientInviteItem)) };
}

// Loads an invite addressed to the patient email or throws 404 (never reveals other people's invites).
async function requirePatientInvite(prisma, { patientId, inviteId }) {
  const email = await findPatientEmail(prisma, patientId);
  const invite = email
    ? await prisma.patientInvite.findFirst({ where: { id: inviteId, email, nutritionist: { deletedAt: null } } })
    : null;
  if (!invite) {
    throw new NotFoundAppError({
      error: NutritionErrorCode.INVITE_NOT_FOUND,
      messageCode: NutritionMessageCode.INVITE_NOT_FOUND,
      message: 'Invite not found.',
    });
  }
  return invite;
}

// Builds the 422 for an invite that is no longer pending.
function notPendingError() {
  return new AppError({
    httpStatus: 422,
    error: NutritionErrorCode.INVITE_NOT_PENDING,
    messageCode: NutritionMessageCode.INVITE_NOT_PENDING,
    message: 'This invite is no longer pending.',
  });
}

// Throws 422 unless the invite is pending and not expired.
function assertInviteAnswerable(invite, now) {
  if (invite.status !== PatientInviteStatus.PENDING) throw notPendingError();
  if (invite.expiresAt < now) {
    throw new AppError({
      httpStatus: 422,
      error: NutritionErrorCode.INVITE_EXPIRED,
      messageCode: NutritionMessageCode.INVITE_EXPIRED,
      message: 'This invite has expired.',
    });
  }
}

// Claims the pending invite and links the nutritionist in one transaction; false when no longer pending.
async function claimInviteAndLink(prisma, { invite, patientId }) {
  return prisma.$transaction(async (tx) => {
    const { count } = await tx.patientInvite.updateMany({
      where: { id: invite.id, status: PatientInviteStatus.PENDING },
      data: { status: PatientInviteStatus.ACCEPTED, patientId, acceptedAt: new Date() },
    });
    if (count === 0) return false;
    await tx.nutritionistPatient.upsert({
      where: { nutritionistId_patientId: { nutritionistId: invite.nutritionistId, patientId } },
      create: { nutritionistId: invite.nutritionistId, patientId },
      update: { deletedAt: null, status: PatientLinkStatus.ACTIVE, createdAt: new Date() },
    });
    return true;
  });
}

/**
 * The patient accepts an invite: the nutritionist link is created now.
 */
export async function acceptPatientInvite(prisma, { patientId, inviteId }) {
  const invite = await requirePatientInvite(prisma, { patientId, inviteId });
  assertInviteAnswerable(invite, new Date());
  if (!(await claimInviteAndLink(prisma, { invite, patientId }))) throw notPendingError();
  return { status: PatientInviteStatus.ACCEPTED };
}

/**
 * The patient declines an invite: no link is created and the nutritionist sees "declined".
 */
export async function declinePatientInvite(prisma, { patientId, inviteId }) {
  const invite = await requirePatientInvite(prisma, { patientId, inviteId });
  assertInviteAnswerable(invite, new Date());
  const { count } = await prisma.patientInvite.updateMany({
    where: { id: invite.id, status: PatientInviteStatus.PENDING },
    data: { status: PatientInviteStatus.DECLINED, patientId },
  });
  if (count === 0) throw notPendingError();
  return { status: PatientInviteStatus.DECLINED };
}
