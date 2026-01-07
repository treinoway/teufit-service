// NOTE: These are string literals stored in DB/session and passed around APIs.
export const Roles = Object.freeze({
  STUDENT: 'student',
  TRAINER: 'trainer',
});

export const roleValues = Object.freeze(Object.values(Roles));
