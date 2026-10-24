import emailHandler from '../config/email-handler.js';
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
  STUDENT_INVITE_LIST_PAGE_SIZE_DEFAULT,
  STUDENT_INVITE_LIST_PAGE_SIZE_MAX,
  studentInviteStatusValues,
} from '../constants/student-invite.js';
import { UserStatus } from '../constants/user-status.js';
import { assertStudentCap } from './platform-plan-service.js';
import { linkStudentByEmail } from './trainer-service.js';
import { maybeMarkFirstStudentLinked } from './trainer-onboarding-service.js';
import { markBriefingDirty } from './briefing-service.js';
import {
  issueCodeRespectingLimits,
  markVerificationSendFailed,
  confirmVerificationCodeDelivered,
  isUserEmailVerified,
} from './email-verification-service.js';

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

/**
 * Sends the invite email and reports whether it was delivered. Never throws.
 * The Resend SDK returns `{ data, error }` instead of throwing, so both a
 * thrown error and a returned `error` count as a failure (logged).
 */
async function deliverInviteEmail(prisma, { trainerUserId, email, emailSender }) {
  try {
    const trainerUser = await prisma.user.findUnique({
      where: { id: trainerUserId },
      select: { firstName: true, lastName: true },
    });
    const response = await emailSender.sendStudentInviteEmail({ to: email, trainerName: buildFullName(trainerUser) });
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

/**
 * Invite email for an existing user whose email is unverified. One email
 * carries the invite AND the verification code (two emails would double the
 * sends, and the stock verification email says "ignore if you did not sign up",
 * which reads as contradictory next to an invite). The code goes through the
 * normal issuing path (cooldown + daily cap); when that blocks or fails the
 * email is still sent, without a code. The previously delivered code is only
 * closed once this email is confirmed sent. Never throws.
 *
 * @returns {Promise<boolean>} whether the invite email was delivered
 */
async function deliverExistingUserInviteEmail(prisma, { userId, trainerUserId, email, emailSender }) {
  let issued = null;
  try {
    issued = await issueCodeRespectingLimits(prisma, userId);
  } catch (issueError) {
    console.warn('Verification code not issued for student invite email', issueError?.messageCode ?? issueError);
  }

  try {
    const trainerUser = await prisma.user.findUnique({
      where: { id: trainerUserId },
      select: { firstName: true, lastName: true },
    });
    const response = await emailSender.sendExistingUserStudentInviteEmail({
      to: email,
      trainerName: buildFullName(trainerUser),
      code: issued?.code ?? null,
    });
    if (!response?.error) {
      if (issued) await confirmVerificationCodeDelivered(prisma, issued);
      return true;
    }
    console.error('Failed to send student invite email', response.error);
  } catch (emailError) {
    console.error('Failed to send student invite email', emailError);
  }
  if (issued) await markVerificationSendFailed(prisma, issued.tokenId);
  return false;
}

/**
 * Id of the active user owning this email when that email is still unverified,
 * else null. Decides whether a resend must carry a verification code.
 */
async function findUnverifiedExistingUserId(prisma, email) {
  const userId = await findUserIdByEmailCaseInsensitive(prisma, email);
  if (!userId) return null;

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { deletedAt: true } });
  if (!user || user.deletedAt) return null;
  return (await isUserEmailVerified(prisma, userId)) ? null : userId;
}

/**
 * Resend delivery: existing unverified users get the variant email with a
 * verification code, everyone else the generic download email. The result
 * reflects the INVITE email only; code issuing is best-effort inside
 * deliverExistingUserInviteEmail and never fails the resend.
 */
async function deliverResendEmail(prisma, { trainerUserId, email, emailSender }) {
  let unverifiedUserId = null;
  try {
    unverifiedUserId = await findUnverifiedExistingUserId(prisma, email);
  } catch (lookupError) {
    console.error('Failed to resolve student invite recipient; sending generic email', lookupError);
  }
  if (!unverifiedUserId) return deliverInviteEmail(prisma, { trainerUserId, email, emailSender });
  return deliverExistingUserInviteEmail(prisma, { userId: unverifiedUserId, trainerUserId, email, emailSender });
}

function throwSelfLink() {
  throw new AppError({
    httpStatus: 422,
    error: StudentInviteErrorCode.CANNOT_LINK_SELF,
    messageCode: StudentInviteMessageCode.CANNOT_LINK_SELF,
    message: 'A trainer cannot link themselves as a student',
  });
}

/** Direct link succeeded: close this trainer's pending invite for the email, if any. */
async function acceptOwnPendingInvite(prisma, { trainerId, email, studentId }) {
  await prisma.studentInvite.updateMany({
    where: { trainerId, email, status: StudentInviteStatus.PENDING },
    data: { status: StudentInviteStatus.ACCEPTED, studentId, acceptedAt: new Date() },
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

/**
 * Existing user: link directly only when their email is verified. An
 * unverified account could be squatted by anyone who typed the address at
 * signup, so it gets a pending invite instead, accepted once the email is
 * verified (verify-email or a verifying OAuth login). Returns null when a
 * pending invite must be created.
 */
async function linkExistingUser(prisma, { trainerId, trainerUserId, userId, email }) {
  const existingUser = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, deletedAt: true },
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

  if (!(await isUserEmailVerified(prisma, existingUser.id))) {
    await assertNotAlreadyLinked(prisma, { trainerId, studentId: existingUser.id });
    return null;
  }

  // linkStudentByEmail matches the stored email exactly, so pass the stored
  // value rather than the normalized input (legacy users may be mixed-case).
  const student = await linkStudentByEmail({ trainerId, trainerUserId, email: existingUser.email });
  await acceptOwnPendingInvite(prisma, { trainerId, email, studentId: student.id });
  return { outcome: StudentInviteOutcome.LINKED, student };
}

function secondsUntil(timestampMs) {
  return Math.max(1, Math.ceil((timestampMs - Date.now()) / MS_PER_SECOND));
}

/**
 * Per-trainer rolling-window cap on invite emails (1 indexed query).
 * Counting rule: only invites CREATED in the window count. Resends are not
 * counted: there is no send log, and per-invite cooldown + max sends already
 * bound them. Direct links (no email) never reach this check.
 */
async function assertDailyInviteLimitNotReached(prisma, trainerId) {
  const now = Date.now();
  const recentInvites = await prisma.studentInvite.findMany({
    where: { trainerId, createdAt: { gte: new Date(now - STUDENT_INVITE_DAILY_WINDOW_MS) } },
    orderBy: { createdAt: 'desc' },
    take: STUDENT_INVITE_DAILY_MAX,
    select: { createdAt: true },
  });
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

async function createPendingInvite(prisma, { trainerId, email }) {
  // A time-expired invite is still `pending` in the DB (no write on read) and
  // would trip the partial unique index, although the list reports it as
  // expired. Flip it first so the trainer can invite the email again.
  await prisma.studentInvite.updateMany({
    where: { trainerId, email, status: StudentInviteStatus.PENDING, expiresAt: { lt: new Date() } },
    data: { status: StudentInviteStatus.EXPIRED },
  });

  try {
    return await prisma.studentInvite.create({
      data: {
        trainerId,
        email,
        expiresAt: new Date(Date.now() + STUDENT_INVITE_TTL_MS),
      },
    });
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
 * Trainer adds a student by email.
 * - Existing user with a VERIFIED email -> link immediately (linkStudentByEmail).
 * - Existing user with an unverified email -> pending invite + one email that
 *   carries the invite and a verification code (accepted once verified).
 * - No user -> pending invite + download email; accepted once the signup email
 *   is verified.
 *
 * Deactivated users and the trainer's own account are rejected (422) before
 * the verified/unverified split.
 */
export async function inviteStudent(
  prisma,
  { trainerId, trainerUserId, email },
  { emailSender = emailHandler } = {},
) {
  const normalizedEmail = normalizeEmail(email);

  const existingUserId = await findUserIdByEmailCaseInsensitive(prisma, normalizedEmail);
  if (existingUserId) {
    const linked = await linkExistingUser(prisma, {
      trainerId,
      trainerUserId,
      userId: existingUserId,
      email: normalizedEmail,
    });
    if (linked) return linked;
  }

  await assertDailyInviteLimitNotReached(prisma, trainerId);
  await assertStudentCap(prisma, trainerId);

  const invite = await createPendingInvite(prisma, { trainerId, email: normalizedEmail });
  if (existingUserId) {
    await deliverExistingUserInviteEmail(prisma, {
      userId: existingUserId,
      trainerUserId,
      email: normalizedEmail,
      emailSender,
    });
  } else {
    await deliverInviteEmail(prisma, { trainerUserId, email: normalizedEmail, emailSender });
  }

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

  const delivered = await deliverResendEmail(prisma, { trainerUserId, email: invite.email, emailSender });
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
 * TrainerStudent link. Returns false when the invite was no longer pending
 * (e.g. revoked concurrently), in which case nothing is linked.
 */
async function claimInviteAndLink(prisma, { invite, studentId, activeOnPlan }) {
  return prisma.$transaction(async (tx) => {
    const { count } = await tx.studentInvite.updateMany({
      where: { id: invite.id, status: StudentInviteStatus.PENDING },
      data: { status: StudentInviteStatus.ACCEPTED, studentId, acceptedAt: new Date() },
    });
    if (count === 0) return false;

    await tx.trainerStudent.createMany({
      data: [{ trainerId: invite.trainerId, studentId, activeOnPlan }],
      skipDuplicates: true,
    });
    await tx.user.update({ where: { id: studentId }, data: { status: UserStatus.ACTIVE } });
    return true;
  });
}

async function acceptSingleInvite(prisma, { invite, user }) {
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
 * Accepts every pending, unexpired invite addressed to the user's (verified)
 * email; expired pending invites are flipped to `expired`.
 * Never throws: failures are logged so signup/verification is never broken.
 * Queries: 1 lookup + ~5 per accepted invite (typically 1 invite per email).
 *
 * @returns {Promise<number>} number of invites accepted
 */
export async function acceptPendingInvitesForUser(prisma, user) {
  const email = normalizeEmail(user?.email);
  if (!user?.id || !email) return 0;

  let acceptedCount = 0;
  try {
    const pendingInvites = await prisma.studentInvite.findMany({
      where: { email, status: StudentInviteStatus.PENDING },
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
