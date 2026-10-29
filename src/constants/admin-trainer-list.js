export const ADMIN_ACCOUNT_TYPE = Object.freeze({
  TRAINER: 'trainer',
  SIGNUP: 'signup',
});

export const ADMIN_INVITE_STATUS = Object.freeze({
  NONE: 'none',
  PENDING: 'pending',
  ACCEPTED: 'accepted',
});

export const adminInviteStatusValues = Object.freeze(Object.values(ADMIN_INVITE_STATUS));
