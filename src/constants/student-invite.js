export const StudentInviteStatus = Object.freeze({
  PENDING: 'pending',
  ACCEPTED: 'accepted',
  REVOKED: 'revoked',
  EXPIRED: 'expired',
  DECLINED: 'declined',
});

export const studentInviteStatusValues = Object.freeze(Object.values(StudentInviteStatus));

export const StudentInviteOutcome = Object.freeze({
  LINKED: 'linked',
  INVITED: 'invited',
});

export const StudentInviteErrorCode = Object.freeze({
  NOT_FOUND: 'STUDENT_INVITE_NOT_FOUND',
  NOT_PENDING: 'STUDENT_INVITE_NOT_PENDING',
  RESEND_COOLDOWN: 'STUDENT_INVITE_RESEND_COOLDOWN',
  RESEND_LIMIT: 'STUDENT_INVITE_RESEND_LIMIT',
  ALREADY_PENDING: 'STUDENT_INVITE_ALREADY_PENDING',
  STUDENT_ACCOUNT_DEACTIVATED: 'STUDENT_ACCOUNT_DEACTIVATED',
  TRAINER_PROFILE_MISSING: 'TRAINER_PROFILE_MISSING',
  DAILY_LIMIT: 'STUDENT_INVITE_DAILY_LIMIT',
  EMAIL_SEND_FAILED: 'STUDENT_INVITE_EMAIL_SEND_FAILED',
  CANNOT_LINK_SELF: 'CANNOT_LINK_SELF',
  EXPIRED: 'STUDENT_INVITE_EXPIRED',
});

export const StudentInviteMessageCode = Object.freeze({
  NOT_FOUND: 'studentInvite.notFound',
  NOT_PENDING: 'studentInvite.notPending',
  RESEND_COOLDOWN: 'studentInvite.resendCooldown',
  RESEND_LIMIT: 'studentInvite.resendLimit',
  ALREADY_PENDING: 'studentInvite.alreadyPending',
  STUDENT_ACCOUNT_DEACTIVATED: 'student.accountDeactivated',
  TRAINER_PROFILE_MISSING: 'trainer.notFound',
  DAILY_LIMIT: 'studentInvite.dailyLimit',
  EMAIL_SEND_FAILED: 'studentInvite.emailSendFailed',
  CANNOT_LINK_SELF: 'student.cannotLinkSelf',
  ALREADY_LINKED: 'student.alreadyLinked',
  EXPIRED: 'studentInvite.expired',
});

const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

export const STUDENT_INVITE_TTL_MS = 30 * MS_PER_DAY;
export const STUDENT_INVITE_RESEND_COOLDOWN_MS = MS_PER_HOUR;
export const STUDENT_INVITE_MAX_SENDS = 5;

export const STUDENT_INVITE_LIST_PAGE_SIZE_DEFAULT = 20;
export const STUDENT_INVITE_LIST_PAGE_SIZE_MAX = 100;

// Rolling-window cap on invite emails per trainer. Only newly created invites
// count (resends are bounded per invite by cooldown + STUDENT_INVITE_MAX_SENDS).
export const STUDENT_INVITE_DAILY_MAX = 50;
export const STUDENT_INVITE_DAILY_WINDOW_MS = MS_PER_DAY;

// Invites a sender with an UNVERIFIED email may create in the same rolling window
// (STUDENT_INVITE_DAILY_WINDOW_MS); the next one answers emailVerification.required.
// Student and patient invites are counted separately.
export const UNVERIFIED_SENDER_INVITE_MAX = 3;
