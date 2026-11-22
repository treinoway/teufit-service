import emailHandler from '../config/email-handler.js';
import { runNonCritical } from '../helpers/non-critical.js';
import { AppError, ConflictAppError, NotFoundAppError } from '../errors/app-error.js';
import { findUserIdByEmailCaseInsensitive } from '../helpers/email-lookup.js';
import { PLATFORM_PLAN_ERRORS } from '../constants/platform-plan.js';
import {
  StudentInviteStatus,
  StudentInviteOutcome,
  StudentInviteErrorCode,
  StudentInviteMessageCode,
  STUDENT_INVITE_TTL_MS,
  STUDENT_INVITE_RESEND_COOLDOWN_MS,
  STUDENT_INVITE_MAX_SENDS,
  STUDENT_INVITE_DAILY_MAX,
  STUDENT_INVITE_DAILY_WINDOW_MS,
  UNVERIFIED_SENDER_INVITE_MAX,
  STUDENT_INVITE_LIST_PAGE_SIZE_DEFAULT,
  STUDENT_INVITE_LIST_PAGE_SIZE_MAX,
  studentInviteStatusValues,
} from '../constants/student-invite.js';
import { UserStatus } from '../constants/user-status.js';
import { assertStudentCap } from './platform-plan-service.js';
import { maybeMarkFirstStudentLinked, maybeMarkFirstStudentInvited } from './trainer-onboarding-service.js';
import { markBriefingDirty } from './briefing-service.js';
import { joinAllModeChallenges } from './challenge-participant-sync.js';
import { assertEmailVerified } from './email-verified-guard.js';

const UNIQUE_VIOLATION_CODE = 'P2002';
const MS_PER_SECOND = 1000;

function normalizeEmail(email) {
  if (typeof email !== 'string') return '';
  return email.trim().toLowerCase();
}

function clampPage(value) {
  const page = Number.isFinite(value) ? Math.floor(value) : 1;
  return page < 1 ? 1 : page;
}

function clampPageSize(value) {
  const pageSize = Number.isFinite(value) ? Math.floor(value) : STUDENT_INVITE_LIST_PAGE_SIZE_DEFAULT;
  if (pageSize < 1) return 1;
  return Math.min(pageSize, STUDENT_INVITE_LIST_PAGE_SIZE_MAX);
}

function buildFullName(user) {
  return `${user?.firstName ?? ''} ${user?.lastName ?? ''}`.trim();
}

/**
 * Status as the trainer should see it: a pending invite past its expiry is
 * reported as expired without writing (no write on read).
 */
function resolveEffectiveStatus(invite, now = new Date()) {
  if (invite.status === StudentInviteStatus.PENDING && invite.expiresAt < now) {
    return StudentInviteStatus.EXPIRED;
  }
  return invite.status;
}

/**
 * Whether/when the trainer can resend this invite, computed from the stored
 * status (a time-expired `pending` invite is revivable, mirroring
 * assertResendAllowed), the send cap and the cooldown.
 *
 * @returns {{ canResend: boolean, resendAvailableAt: Date|null }}
 *   resendAvailableAt is set only while the cooldown blocks an otherwise
 *   resendable invite; null when resend is allowed now or never allowed.
 */
export function computeResendAvailability(invite, now = new Date()) {
  const isResendable =
    invite.status === StudentInviteStatus.PENDING && invite.sendCount < STUDENT_INVITE_MAX_SENDS;
  if (!isResendable) return { canResend: false, resendAvailableAt: null };

  const availableAt = new Date(invite.lastSentAt.getTime() + STUDENT_INVITE_RESEND_COOLDOWN_MS);
  if (availableAt > now) return { canResend: false, resendAvailableAt: availableAt };
  return { canResend: true, resendAvailableAt: null };
}

function withEffectiveStatus(invite) {
  const now = new Date();
  return {
    ...invite,
    status: resolveEffectiveStatus(invite, now),
    ...computeResendAvailability(invite, now),
  };
}

function buildStatusFilter(status, now) {
  if (status === StudentInviteStatus.PENDING) {
    return { status: StudentInviteStatus.PENDING, expiresAt: { gte: now } };
  }
  if (status === StudentInviteStatus.EXPIRED) {
    return {
      OR: [
        { status: StudentInviteStatus.EXPIRED },
        { status: StudentInviteStatus.PENDING, expiresAt: { lt: now } },
      ],
    };
  }
  return { status };
}

// Sends the invite email of the right kind and reports whether it was delivered; never throws (Resend returns `{ error }` instead of throwing).
async function deliverInviteEmail(prisma, { trainerUserId, email, emailSender, requiresConsent }) {
  try {
    const trainerUser = await prisma.user.findUnique({
      where: { id: trainerUserId },
      select: { firstName: true, lastName: true },
    });
    const message = { to: email, trainerName: buildFullName(trainerUser) };
    const response = requiresConsent
      ? await emailSender.sendStudentInviteOpenAppEmail(message)
      : await emailSender.sendStudentInviteEmail(message);
    if (response?.error) {
      console.error('Failed to send student invite email', response.error);
      return false;
    }
    return true;
  } catch (emailError) {
    console.error('Failed to send student invite email', emailError);
    return false;
  }
}

function throwSelfLink() {
  throw new AppError({
    httpStatus: 422,
    error: StudentInviteErrorCode.CANNOT_LINK_SELF,
    messageCode: StudentInviteMessageCode.CANNOT_LINK_SELF,
    message: 'A trainer cannot link themselves as a student',
  });
}

async function assertNotAlreadyLinked(prisma, { trainerId, studentId }) {
  const existing = await prisma.trainerStudent.findUnique({
    where: { trainerId_studentId: { trainerId, studentId } },
    select: { trainerId: true },
  });
  if (existing) {
    throw new ConflictAppError({
      message: 'This student is already linked to your account',
      messageCode: StudentInviteMessageCode.ALREADY_LINKED,
    });
  }
}

// Throws unless the existing account can be invited: 422 when deactivated or the trainer's own, 409 when already linked to this trainer.
async function assertExistingUserInvitable(prisma, { trainerId, trainerUserId, userId }) {
  const existingUser = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, deletedAt: true },
  });

  if (!existingUser || existingUser.deletedAt) {
    throw new AppError({
      httpStatus: 422,
      error: StudentInviteErrorCode.STUDENT_ACCOUNT_DEACTIVATED,
      messageCode: StudentInviteMessageCode.STUDENT_ACCOUNT_DEACTIVATED,
      message: 'This student account is deactivated.',
    });
  }

  if (existingUser.id === trainerUserId) throwSelfLink();
  await assertNotAlreadyLinked(prisma, { trainerId, studentId: existingUser.id });
}

function secondsUntil(timestampMs) {
  return Math.max(1, Math.ceil((timestampMs - Date.now()) / MS_PER_SECOND));
}

// Throws 403 emailVerification.required when a sender with an unverified email already used the unverified allowance.
async function assertUnverifiedSenderWithinCap(prisma, { trainerUserId, recentInviteCount }) {
  if (recentInviteCount < UNVERIFIED_SENDER_INVITE_MAX) return;
  await assertEmailVerified(prisma, trainerUserId);
}

/**
 * Per-trainer rolling-window caps on invite emails (1 indexed query): the
 * unverified-sender allowance first, then the daily cap.
 * Counting rule: only invites CREATED in the window count. Resends are not
 * counted: there is no send log, and per-invite cooldown + max sends already
 * bound them.
 */
async function assertInviteLimitsNotReached(prisma, { trainerId, trainerUserId }) {
  const now = Date.now();
  const recentInvites = await prisma.studentInvite.findMany({
    where: { trainerId, createdAt: { gte: new Date(now - STUDENT_INVITE_DAILY_WINDOW_MS) } },
    orderBy: { createdAt: 'desc' },
    take: STUDENT_INVITE_DAILY_MAX,
    select: { createdAt: true },
  });
  await assertUnverifiedSenderWithinCap(prisma, { trainerUserId, recentInviteCount: recentInvites.length });
  if (recentInvites.length < STUDENT_INVITE_DAILY_MAX) return;

  // The cap-th newest invite leaves the window first, freeing one slot.
  const oldestCountedAt = recentInvites[recentInvites.length - 1].createdAt.getTime();
  throw new AppError({
    httpStatus: 429,
    error: StudentInviteErrorCode.DAILY_LIMIT,
    messageCode: StudentInviteMessageCode.DAILY_LIMIT,
    message: 'Daily invite limit reached. Try again later.',
    details: { retryAfterSeconds: secondsUntil(oldestCountedAt + STUDENT_INVITE_DAILY_WINDOW_MS) },
  });
}

async function createPendingInvite(prisma, { trainerId, email, requiresConsent }) {
  // A time-expired invite is still `pending` in the DB (no write on read) and
  // would trip the partial unique index, although the list reports it as
  // expired. Flip it first so the trainer can invite the email again.
  await prisma.studentInvite.updateMany({
    where: { trainerId, email, status: StudentInviteStatus.PENDING, expiresAt: { lt: new Date() } },
    data: { status: StudentInviteStatus.EXPIRED },
  });

  try {
    const invite = await prisma.studentInvite.create({
      data: {
        trainerId,
        email,
        requiresConsent,
        expiresAt: new Date(Date.now() + STUDENT_INVITE_TTL_MS),
      },
    });
    await runNonCritical('First-student-invited milestone', () =>
      maybeMarkFirstStudentInvited({ trainerId, tx: prisma }),
    );
    return invite;
  } catch (error) {
    // Partial unique index (trainer_id, email) WHERE status = 'pending'.
    if (error?.code === UNIQUE_VIOLATION_CODE) {
      throw new ConflictAppError({
        error: StudentInviteErrorCode.ALREADY_PENDING,
        messageCode: StudentInviteMessageCode.ALREADY_PENDING,
        message: 'There is already a pending invite for this email.',
      });
    }
    throw error;
  }
}

/**
 * Trainer invites a student by email; nobody is ever linked without the student's own action.
 * - Existing account (verified or not) -> pending invite with requiresConsent + "open the app" email; the student accepts or declines in the app.
 * - No account -> pending invite + download email; accepted automatically once the signup email is verified.
 *
 * Deactivated accounts, the trainer's own account (422) and already-linked students (409) are rejected before the caps.
 */
export async function inviteStudent(
  prisma,
  { trainerId, trainerUserId, email },
  { emailSender = emailHandler } = {},
) {
  const normalizedEmail = normalizeEmail(email);

  const existingUserId = await findUserIdByEmailCaseInsensitive(prisma, normalizedEmail);
  if (existingUserId) {
    await assertExistingUserInvitable(prisma, { trainerId, trainerUserId, userId: existingUserId });
  }
  const requiresConsent = Boolean(existingUserId);

  await assertInviteLimitsNotReached(prisma, { trainerId, trainerUserId });
  await assertStudentCap(prisma, trainerId);

  const invite = await createPendingInvite(prisma, { trainerId, email: normalizedEmail, requiresConsent });
  await deliverInviteEmail(prisma, { trainerUserId, email: normalizedEmail, emailSender, requiresConsent });

  return { outcome: StudentInviteOutcome.INVITED, invite: withEffectiveStatus(invite) };
}

/**
 * Lists a trainer's invites (2 queries: findMany + count). Expired-by-time
 * pending invites are reported and filtered as `expired`.
 */
export async function listStudentInvites(prisma, { trainerId, status, page, pageSize }) {
  const where = { trainerId };
  if (status !== undefined && studentInviteStatusValues.includes(status)) {
    Object.assign(where, buildStatusFilter(status, new Date()));
  }

  const currentPage = clampPage(page);
  const currentPageSize = clampPageSize(pageSize);

  const [items, total] = await Promise.all([
    prisma.studentInvite.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (currentPage - 1) * currentPageSize,
      take: currentPageSize,
    }),
    prisma.studentInvite.count({ where }),
  ]);

  return { items: items.map(withEffectiveStatus), total, page: currentPage, pageSize: currentPageSize };
}

async function requireOwnedInvite(prisma, { trainerId, inviteId }) {
  const invite = await prisma.studentInvite.findFirst({ where: { id: inviteId, trainerId } });
  if (!invite) {
    throw new NotFoundAppError({
      error: StudentInviteErrorCode.NOT_FOUND,
      messageCode: StudentInviteMessageCode.NOT_FOUND,
      message: 'Invite not found.',
    });
  }
  return invite;
}

function throwNotPending() {
  throw new ConflictAppError({
    error: StudentInviteErrorCode.NOT_PENDING,
    messageCode: StudentInviteMessageCode.NOT_PENDING,
    message: 'Only pending invites can be changed.',
  });
}

function throwResendCooldown(remainingMs) {
  throw new AppError({
    httpStatus: 429,
    error: StudentInviteErrorCode.RESEND_COOLDOWN,
    messageCode: StudentInviteMessageCode.RESEND_COOLDOWN,
    message: 'Please wait before resending this invite.',
    details: { retryAfterSeconds: Math.max(1, Math.ceil(remainingMs / MS_PER_SECOND)) },
  });
}

function assertResendAllowed(invite, now) {
  if (invite.status !== StudentInviteStatus.PENDING) throwNotPending();

  if (invite.sendCount >= STUDENT_INVITE_MAX_SENDS) {
    throw new ConflictAppError({
      error: StudentInviteErrorCode.RESEND_LIMIT,
      messageCode: StudentInviteMessageCode.RESEND_LIMIT,
      message: 'This invite reached its resend limit.',
    });
  }

  const remainingMs = invite.lastSentAt.getTime() + STUDENT_INVITE_RESEND_COOLDOWN_MS - now.getTime();
  if (remainingMs > 0) throwResendCooldown(remainingMs);
}

/**
 * The trainer explicitly asked for this email, so a failed delivery is a 502
 * (not a silent success). The send bookkeeping is rolled back so the failed
 * attempt does not burn the 1h cooldown or one of the max sends.
 */
async function rollbackResendBookkeeping(prisma, { previous, resentAt }) {
  try {
    await prisma.studentInvite.updateMany({
      where: { id: previous.id, status: StudentInviteStatus.PENDING, lastSentAt: resentAt },
      data: {
        expiresAt: previous.expiresAt,
        lastSentAt: previous.lastSentAt,
        sendCount: { decrement: 1 },
      },
    });
  } catch (rollbackError) {
    console.error('Failed to roll back student invite resend', rollbackError);
  }
}

/**
 * Resend a pending invite (a time-expired pending invite is revived).
 * The conditional updateMany makes concurrent resends race-safe: only one
 * caller passes the cooldown/limit guard. Delivery failure -> 502 + rollback.
 */
export async function resendStudentInvite(
  prisma,
  { trainerId, trainerUserId, inviteId },
  { emailSender = emailHandler } = {},
) {
  const invite = await requireOwnedInvite(prisma, { trainerId, inviteId });
  const now = new Date();
  assertResendAllowed(invite, now);

  const { count } = await prisma.studentInvite.updateMany({
    where: {
      id: invite.id,
      status: StudentInviteStatus.PENDING,
      sendCount: { lt: STUDENT_INVITE_MAX_SENDS },
      lastSentAt: { lte: new Date(now.getTime() - STUDENT_INVITE_RESEND_COOLDOWN_MS) },
    },
    data: {
      expiresAt: new Date(now.getTime() + STUDENT_INVITE_TTL_MS),
      lastSentAt: now,
      sendCount: { increment: 1 },
    },
  });

  if (count === 0) {
    // Lost a race (concurrent resend, revoke or accept): report the real reason.
    const current = await requireOwnedInvite(prisma, { trainerId, inviteId });
    assertResendAllowed(current, now);
    throwResendCooldown(STUDENT_INVITE_RESEND_COOLDOWN_MS);
  }

  const delivered = await deliverInviteEmail(prisma, {
    trainerUserId,
    email: invite.email,
    emailSender,
    requiresConsent: invite.requiresConsent === true,
  });
  if (!delivered) {
    await rollbackResendBookkeeping(prisma, { previous: invite, resentAt: now });
    throw new AppError({
      httpStatus: 502,
      error: StudentInviteErrorCode.EMAIL_SEND_FAILED,
      messageCode: StudentInviteMessageCode.EMAIL_SEND_FAILED,
      message: 'Could not send the invite email. Try again shortly.',
    });
  }

  const updated = await prisma.studentInvite.findUnique({ where: { id: invite.id } });
  return withEffectiveStatus(updated);
}

/** Cancel a pending invite. Conditional updateMany makes revoke-vs-accept race-safe. */
export async function revokeStudentInvite(prisma, { trainerId, inviteId }) {
  const { count } = await prisma.studentInvite.updateMany({
    where: { id: inviteId, trainerId, status: StudentInviteStatus.PENDING },
    data: { status: StudentInviteStatus.REVOKED, revokedAt: new Date() },
  });

  if (count === 0) {
    await requireOwnedInvite(prisma, { trainerId, inviteId });
    throwNotPending();
  }

  const revoked = await prisma.studentInvite.findUnique({ where: { id: inviteId } });
  return withEffectiveStatus(revoked);
}

async function hasStudentCapacity(prisma, trainerId) {
  try {
    await assertStudentCap(prisma, trainerId);
    return true;
  } catch (error) {
    if (error?.error === PLATFORM_PLAN_ERRORS.STUDENT_CAP_EXCEEDED.code) return false;
    throw error;
  }
}

/**
 * Atomically claims a pending invite (pending -> accepted) and creates the
 * TrainerStudent link, then joins the student to the trainer's all-mode weekly
 * championships outside the transaction. Returns false when the invite was no
 * longer pending or already past its expiry at claim time (e.g. revoked or
 * expired concurrently), in which case nothing is linked.
 */
async function claimInviteAndLink(prisma, { invite, studentId, activeOnPlan }) {
  const claimed = await prisma.$transaction(async (tx) => {
    const claimedAt = new Date();
    const { count } = await tx.studentInvite.updateMany({
      where: { id: invite.id, status: StudentInviteStatus.PENDING, expiresAt: { gte: claimedAt } },
      data: { status: StudentInviteStatus.ACCEPTED, studentId, acceptedAt: claimedAt },
    });
    if (count === 0) return false;

    await tx.trainerStudent.createMany({
      data: [{ trainerId: invite.trainerId, studentId, activeOnPlan }],
      skipDuplicates: true,
    });
    await tx.user.update({ where: { id: studentId }, data: { status: UserStatus.ACTIVE } });
    return true;
  });
  if (claimed) await joinInvitedStudentToChallenges(prisma, invite.trainerId, studentId);
  return claimed;
}

// Live "all" mode (CAMP-13): puts the invited student in the trainer's open all-mode weekly championships; a failure is logged and the link kept
async function joinInvitedStudentToChallenges(prisma, trainerId, studentId) {
  try {
    await joinAllModeChallenges(prisma, trainerId, studentId, new Date());
  } catch (err) {
    console.error(
      { trainerId, studentId, err },
      `[challenge-sync] failed to add student ${studentId} to the all-mode championships of trainer ${trainerId}`,
    );
  }
}

/**
 * Accepts one pending invite for the user: claims it, links the student (inactive when over the plan cap) and fires the link side effects.
 *
 * @returns {Promise<boolean>} false when the invite was no longer pending or had expired at claim time (nothing is linked)
 */
export async function acceptSingleInvite(prisma, { invite, user }) {
  // Over the plan cap the link is still created (inactive) so the invite is
  // never lost; the trainer sees the BLOCKED_ON_PLAN blocker.
  const activeOnPlan = await hasStudentCapacity(prisma, invite.trainerId);
  const claimed = await claimInviteAndLink(prisma, { invite, studentId: user.id, activeOnPlan });
  if (!claimed) return false;

  await maybeMarkFirstStudentLinked({ trainerId: invite.trainerId, tx: prisma });
  await markBriefingDirty(prisma, invite.trainerId);
  return true;
}

/**
 * Accepts the pending student invites of the user's verified email, except the ones that need explicit consent (requiresConsent, like patient invites); never throws.
 *
 * @returns {Promise<number>} number of invites accepted
 */
export async function acceptPendingInvitesForUser(prisma, user) {
  const email = normalizeEmail(user?.email);
  if (!user?.id || !email) return 0;

  let acceptedCount = 0;
  try {
    const pendingInvites = await prisma.studentInvite.findMany({
      where: { email, status: StudentInviteStatus.PENDING, requiresConsent: false },
      select: { id: true, trainerId: true, expiresAt: true },
    });

    const now = new Date();
    for (const invite of pendingInvites) {
      try {
        if (invite.expiresAt < now) {
          // Re-check expiry in the write: a concurrent resend may have revived it.
          await prisma.studentInvite.updateMany({
            where: { id: invite.id, status: StudentInviteStatus.PENDING, expiresAt: { lt: now } },
            data: { status: StudentInviteStatus.EXPIRED },
          });
          continue;
        }
        if (await acceptSingleInvite(prisma, { invite, user })) acceptedCount += 1;
      } catch (inviteError) {
        console.error('Failed to accept student invite', { inviteId: invite.id, inviteError });
      }
    }
  } catch (error) {
    console.error('Failed to accept pending student invites', error);
  }

  return acceptedCount;
}
