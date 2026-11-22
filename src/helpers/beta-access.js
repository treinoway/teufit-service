/**
 * Whether a user may use the web app. Signup is open, so every authenticated
 * user has access: no invite, role or `betaInviteGate` flag is consulted.
 *
 * Kept (always true) because `betaAccess` stays in the contract of GET /me,
 * PATCH /me/profile, POST /auth/signup/invite and POST /invite/redeem, and old
 * web builds still redirect to the invite wall when it is false.
 *
 * Async and outside trainer-invite-service.js (which re-exports it) for the
 * existing callers; `null`/`undefined` stays false as a defensive guard.
 *
 * @param {{ id?: string, email?: string|null, roles?: string[] }|null|undefined} user
 * @returns {Promise<boolean>}
 */
export async function hasBetaAccess(user) {
  return Boolean(user);
}
