import config from '../../config/index.js';
import { prisma } from '../db.js';
import { Roles } from '../constants/roles.js';
import { InviteStatus } from '../constants/trainer-invite.js';

/**
 * Whether an email is on the BETA_TESTER_EMAILS allowlist (config-driven,
 * normalized trimmed/lowercase — see config/environments/default.js). Lets
 * QA test the invite-gated flow without redeeming a real invite.
 *
 * @param {string|null|undefined} email
 * @returns {boolean}
 */
function isTesterAllowlistedEmail(email) {
  if (typeof email !== 'string') return false;
  const normalized = email.trim().toLowerCase();
  if (!normalized) return false;
  const testerEmails = config.betaInviteGate?.testerEmails || [];
  return testerEmails.includes(normalized);
}

/**
 * Whether a user may use the web app during the closed beta.
 *
 * When `config.betaInviteGate.enabled` is false (kill-switch), everyone has
 * access — short-circuits before any exemption check or DB hit, so this is
 * the single source of truth for the `betaAccess` flag returned on `/me`.
 * Callers that need the boolean (user-service.js's toUserProfile, trainer-
 * invite-route.js via redeemInvite's updatedUser.betaAccess) should never
 * see `false` for a gate the middleware would actually let them through.
 *
 * This does NOT check the ordering the same way requireBetaAccess() does in
 * api/middleware/auth.js: that middleware checks the gate flag before the
 * `!request.user` guard (config.betaInviteGate?.enabled === false returns
 * before authentication is even verified), while this helper checks `!user`
 * first and the gate second. Both are correct for where each is actually
 * called — the middleware's ordering means a disabled gate skips the auth
 * check entirely on its one mounted route (PATCH /become-trainer, which
 * still requires `authenticate` as a separate preHandler ahead of it), while
 * this helper is only ever invoked with a user already resolved by the
 * caller, so `!user` is a defensive guard, not a live path.
 *
 * Side effect worth knowing: while the gate is disabled, `betaAccess` is
 * `true` for every user, including one holding a pending, unredeemed
 * invite — nothing prompts them to redeem it. `POST /invite/redeem` still
 * works if reached directly. When the gate is re-enabled, everyone who
 * didn't redeem during the disabled window is gated again at once.
 *
 * Otherwise, exempt (no DB hit): admin role, trainer role, tester allowlist
 * (BETA_TESTER_EMAILS) — this is what keeps grandfathered prod trainers,
 * admins, and QA testers unlocked with no data backfill. Everyone else
 * needs an accepted TrainerInvite row.
 *
 * Lives outside trainer-invite-service.js (which it is re-exported from) so
 * user-service.js can depend on it without creating a cycle: trainer-invite-
 * service.js already imports setActiveProfileToTrainer from user-service.js.
 *
 * @param {{ id?: string, email?: string|null, roles?: string[] }} user
 * @returns {Promise<boolean>}
 */
export async function hasBetaAccess(user) {
  if (!user) return false;

  if (config.betaInviteGate?.enabled === false) return true;

  const roles = Array.isArray(user.roles) ? user.roles : [];
  if (
    isTesterAllowlistedEmail(user.email) ||
    roles.includes(Roles.ADMIN) ||
    roles.includes(Roles.TRAINER)
  ) {
    return true;
  }

  if (!user.id) return false;

  const acceptedInvite = await prisma.trainerInvite.findFirst({
    where: { userId: user.id, status: InviteStatus.ACCEPTED },
    select: { id: true },
  });

  return Boolean(acceptedInvite);
}
