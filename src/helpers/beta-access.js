import { prisma } from '../db.js';
import { Roles } from '../constants/roles.js';
import { isBootstrapAdminEmail } from '../constants/admin.js';
import { InviteStatus } from '../constants/trainer-invite.js';

/**
 * Whether a user may use the web app during the closed beta.
 *
 * Exempt (no DB hit): bootstrap admin, admin role, trainer role — this is what
 * keeps grandfathered prod trainers and the bootstrap admin unlocked with no
 * data backfill. Everyone else needs an accepted TrainerInvite row.
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

  const roles = Array.isArray(user.roles) ? user.roles : [];
  if (isBootstrapAdminEmail(user.email) || roles.includes(Roles.ADMIN) || roles.includes(Roles.TRAINER)) {
    return true;
  }

  if (!user.id) return false;

  const acceptedInvite = await prisma.trainerInvite.findFirst({
    where: { userId: user.id, status: InviteStatus.ACCEPTED },
    select: { id: true },
  });

  return Boolean(acceptedInvite);
}
