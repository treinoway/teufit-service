export const InviteStatus = Object.freeze({
  PENDING: 'pending',
  ACCEPTED: 'accepted',
  REVOKED: 'revoked',
  EXPIRED: 'expired',
});

export const inviteStatusValues = Object.freeze(Object.values(InviteStatus));

export const InviteErrorCode = Object.freeze({
  INVITE_NOT_FOUND: 'INVITE_NOT_FOUND',
  INVITE_EXPIRED: 'INVITE_EXPIRED',
  INVITE_REVOKED: 'INVITE_REVOKED',
  INVITE_ALREADY_ACCEPTED: 'INVITE_ALREADY_ACCEPTED',
  INVITE_EMAIL_MISMATCH: 'INVITE_EMAIL_MISMATCH',
  INVITE_REQUIRED: 'INVITE_REQUIRED',
  INVITE_ALREADY_ACTIVE_FOR_EMAIL: 'INVITE_ALREADY_ACTIVE_FOR_EMAIL',
});

export const InviteMessageCode = Object.freeze({
  NOT_FOUND: 'invite.notFound',
  EXPIRED: 'invite.expired',
  REVOKED: 'invite.revoked',
  ALREADY_ACCEPTED: 'invite.alreadyAccepted',
  EMAIL_MISMATCH: 'invite.emailMismatch',
  REQUIRED: 'invite.required',
  ALREADY_ACTIVE_FOR_EMAIL: 'invite.alreadyActiveForEmail',
});

// Invites live for 7 days — long enough for the invited trainer to see the
// email and sign up/log in, short enough to keep the ~50-bit code space safe
// against brute force (see INVITE_CODE_ALPHABET below).
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Crockford base32 (no I, L, O, U — avoids visual ambiguity when typed manually).
// 10 chars from a 32-symbol alphabet = 32^10 = 2^50 ≈ 50 bits of entropy.
export const INVITE_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export const INVITE_LIST_PAGE_SIZE_DEFAULT = 20;
export const INVITE_LIST_PAGE_SIZE_MAX = 100;
