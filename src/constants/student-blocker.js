/**
 * Student readiness blockers.
 *
 * Surfaced on GET /trainer/students as `blockers[]` (+ `ready` boolean) so the
 * trainer can see everything preventing a student from being fully
 * operational — not just a single computed status. A student can accumulate
 * more than one blocker at the same time (e.g. no active protocol AND an
 * overdue payment).
 *
 * Array order in the response follows declaration order below. This is
 * deterministic by construction: `computeStudentBlockers` (trainer-service.js)
 * evaluates conditions in this exact sequence and pushes to the array
 * conditionally, never reorders or sorts afterwards.
 */
export const StudentBlocker = Object.freeze({
  NO_ACTIVE_PROTOCOL: 'no_active_protocol',
  NO_SUBSCRIPTION: 'no_subscription',
  SUBSCRIPTION_CANCELLED: 'subscription_cancelled',
  SUBSCRIPTION_OVERDUE: 'subscription_overdue',
  BLOCKED_ON_PLAN: 'blocked_on_plan',
});

export const studentBlockerValues = Object.freeze(Object.values(StudentBlocker));
