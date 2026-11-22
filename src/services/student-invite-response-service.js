import s3BucketHandler from '../config/s3-bucket-handler.js';
import { isUserEmailVerified } from './email-verified-guard.js';
import { acceptSingleInvite } from './student-invite-service.js';
import { AppError, ConflictAppError, NotFoundAppError } from '../errors/app-error.js';
import { StudentInviteStatus, StudentInviteErrorCode, StudentInviteMessageCode } from '../constants/student-invite.js';

// Lowercases and trims an email.
function normalizeEmail(email) {
  if (typeof email !== 'string') return '';
  return email.trim().toLowerCase();
}

// Lowercased email of an active user with a verified email, or null.
async function findStudentEmail(prisma, studentId) {
  if (!(await isUserEmailVerified(prisma, studentId))) return null;
  const user = await prisma.user.findUnique({ where: { id: studentId }, select: { email: true, deletedAt: true } });
  if (!user || user.deletedAt) return null;
  return normalizeEmail(user.email) || null;
}

// Maps an invite row to the student-facing item (names are never null: empty string; avatar resolved to a URL).
async function toStudentInviteItem(invite) {
  const { firstName, lastName, avatarUrl } = invite.trainer.user;
  return {
    id: invite.id,
    trainer: { firstName: firstName ?? '', lastName: lastName ?? '', avatarUrl: await s3BucketHandler.resolveUrl(avatarUrl) },
    createdAt: invite.createdAt,
    expiresAt: invite.expiresAt,
  };
}

/**
 * Pending, unexpired trainer invites that wait for the consent of the student, addressed to the student's verified email.
 */
export async function listInvitesForStudent(prisma, { studentId }) {
  const email = await findStudentEmail(prisma, studentId);
  if (!email) return { items: [] };
  const invites = await prisma.studentInvite.findMany({
    where: {
      email,
      status: StudentInviteStatus.PENDING,
      requiresConsent: true,
      expiresAt: { gt: new Date() },
      trainer: { deletedAt: null },
    },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      createdAt: true,
      expiresAt: true,
      trainer: { select: { user: { select: { firstName: true, lastName: true, avatarUrl: true } } } },
    },
  });
  return { items: await Promise.all(invites.map(toStudentInviteItem)) };
}

// Loads a consent invite addressed to the student email or throws 404 (never reveals other people's invites).
async function requireStudentInvite(prisma, { studentId, inviteId }) {
  const email = await findStudentEmail(prisma, studentId);
  const invite = email
    ? await prisma.studentInvite.findFirst({
      where: { id: inviteId, email, requiresConsent: true, trainer: { deletedAt: null } },
      select: { id: true, trainerId: true, status: true, expiresAt: true },
    })
    : null;
  if (!invite) {
    throw new NotFoundAppError({
      error: StudentInviteErrorCode.NOT_FOUND,
      messageCode: StudentInviteMessageCode.NOT_FOUND,
      message: 'Invite not found.',
    });
  }
  return invite;
}

// Builds the 409 for an invite that is no longer pending.
function notPendingError() {
  return new ConflictAppError({
    error: StudentInviteErrorCode.NOT_PENDING,
    messageCode: StudentInviteMessageCode.NOT_PENDING,
    message: 'This invite is no longer pending.',
  });
}

// Throws 409 unless the invite is pending and 422 when it is past its expiry.
function assertInviteAnswerable(invite, now) {
  if (invite.status !== StudentInviteStatus.PENDING) throw notPendingError();
  if (invite.expiresAt < now) {
    throw new AppError({
      httpStatus: 422,
      error: StudentInviteErrorCode.EXPIRED,
      messageCode: StudentInviteMessageCode.EXPIRED,
      message: 'This invite has expired.',
    });
  }
}

// Rejects an answer whose atomic claim lost: 422 when the invite expired meanwhile, 409 otherwise.
async function throwLostClaim(prisma, inviteId) {
  const current = await prisma.studentInvite.findUnique({ where: { id: inviteId }, select: { status: true, expiresAt: true } });
  if (current) assertInviteAnswerable(current, new Date());
  throw notPendingError();
}

/**
 * The student accepts a trainer invite: the trainer link is created now, exactly as an automatically accepted invite.
 */
export async function acceptStudentInvite(prisma, { studentId, inviteId }) {
  const invite = await requireStudentInvite(prisma, { studentId, inviteId });
  assertInviteAnswerable(invite, new Date());
  if (!(await acceptSingleInvite(prisma, { invite, user: { id: studentId } }))) await throwLostClaim(prisma, invite.id);
  return { status: StudentInviteStatus.ACCEPTED };
}

/**
 * The student declines a trainer invite: no link is created and the trainer sees "declined".
 */
export async function declineStudentInvite(prisma, { studentId, inviteId }) {
  const invite = await requireStudentInvite(prisma, { studentId, inviteId });
  assertInviteAnswerable(invite, new Date());
  const { count } = await prisma.studentInvite.updateMany({
    where: { id: invite.id, status: StudentInviteStatus.PENDING, expiresAt: { gte: new Date() } },
    data: { status: StudentInviteStatus.DECLINED },
  });
  if (count === 0) await throwLostClaim(prisma, invite.id);
  return { status: StudentInviteStatus.DECLINED };
}
