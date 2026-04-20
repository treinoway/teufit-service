// NOTE: These are string literals stored in DB/session and passed around APIs.
export const Roles = Object.freeze({
  TRAINER: 'trainer',
  NUTRITIONIST: 'nutritionist',
  ADMIN: 'admin',
});

export const roleValues = Object.freeze(Object.values(Roles));
