import config from '../../config/index.js';
import { AppError } from '../errors/app-error.js';
import { EmailVerificationErrorCode, EmailVerificationMessageCode } from '../constants/email-verification.js';

// Lives outside email-verification-service.js, which imports student-invite-service.js (-> platform-plan-service.js); both need this guard.

/** True when ANY of the user's accounts has a verifiedAt; a missing userId is never verified (and is not queried). */
export async function isUserEmailVerified(prisma, userId) {
  // why: Prisma drops an undefined filter, so `{ userId: undefined }` would match a verified account of ANY user.
  if (!userId) return false;
  const account = await prisma.account.findFirst({
    where: { userId, verifiedAt: { not: null } },
    select: { id: true },
  });
  return Boolean(account);
}

// Builds the 403 answered when an action needs a verified email (clients open the confirmation modal on this messageCode).
function createEmailVerificationRequiredError() {
  return new AppError({
    httpStatus: 403,
    error: EmailVerificationErrorCode.REQUIRED,
    messageCode: EmailVerificationMessageCode.REQUIRED,
    message: 'Confirm your email to continue.',
  });
}

// True only when the stored creation date proves the account is older than the open-signup cut-off (config.emailVerification.enforcedFrom).
async function wasCreatedBeforeEnforcement(prisma, userId) {
  if (!userId) return false;
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { createdAt: true } });
  if (!(user?.createdAt instanceof Date)) return false;
  return user.createdAt.getTime() < new Date(config.emailVerification.enforcedFrom).getTime();
}

// Throws 403 emailVerification.required unless the user has a verified account or was created before the open-signup cut-off; a missing userId is refused.
export async function assertEmailVerified(prisma, userId) {
  if (await isUserEmailVerified(prisma, userId)) return;
  if (await wasCreatedBeforeEnforcement(prisma, userId)) return;
  throw createEmailVerificationRequiredError();
}
