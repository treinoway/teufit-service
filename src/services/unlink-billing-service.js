import {
  CANCELLATION_REASON_UNLINKED,
  ServiceType,
  SubscriptionStatus,
} from '../constants/subscription.js';
import { todayInBusinessTz } from '../helpers/date-helpers.js';
import { cancelUpcomingPayments } from './subscription-cycle-service.js';
import { loadLinks } from './professional-owner-service.js';

export const UnlinkedProfessional = Object.freeze({
  TRAINER: 'trainer',
  NUTRITIONIST: 'nutritionist',
});

// Where branches of the active subscriptions that lost every link they need after a trainer unlink.
function trainerUnlinkBranches(owner, patientLinked) {
  const serviceTypes = patientLinked ? [ServiceType.TRAINING] : [ServiceType.TRAINING, ServiceType.BOTH];
  return [{ serviceType: { in: serviceTypes }, trainerId: owner.trainerId }];
}

// Where branches of the active subscriptions that lost every link they need after a nutritionist unlink.
function nutritionistUnlinkBranches(owner, trainerLinked) {
  const branches = [{ serviceType: ServiceType.NUTRITION, nutritionistId: owner.nutritionistId }];
  if (!trainerLinked && owner.trainerId) {
    branches.push({ serviceType: ServiceType.BOTH, trainerId: owner.trainerId });
  }
  return branches;
}

// Picks the branches for the professional that was just unlinked, given the links that remain.
function buildUnlinkBranches(unlinked, owner, links) {
  return unlinked === UnlinkedProfessional.TRAINER
    ? trainerUnlinkBranches(owner, links.patientLinked)
    : nutritionistUnlinkBranches(owner, links.trainerLinked);
}

/**
 * Cancels the owner's active subscriptions with a person that lost every link they need and voids their upcoming charges.
 *
 * @param {import('@prisma/client').Prisma.TransactionClient} tx
 * @param {{ owner: { userId: string, trainerId: string|null, nutritionistId: string|null }, studentId: string, unlinked: string, now: Date }} options
 * @returns {Promise<void>}
 */
export async function cancelSubscriptionsAfterUnlink(tx, { owner, studentId, unlinked, now }) {
  const links = await loadLinks(tx, owner, studentId);

  const scope = { studentId, OR: buildUnlinkBranches(unlinked, owner, links) };

  const activeSubscriptions = await tx.studentSubscription.findMany({
    where: { ...scope, status: SubscriptionStatus.ACTIVE },
    select: { id: true },
  });
  if (activeSubscriptions.length > 0) {
    await tx.studentSubscription.updateMany({
      where: { id: { in: activeSubscriptions.map((subscription) => subscription.id) }, status: SubscriptionStatus.ACTIVE },
      data: {
        status: SubscriptionStatus.CANCELLED,
        cancelledAt: now,
        cancellationReason: CANCELLATION_REASON_UNLINKED,
      },
    });
  }
  // why: a replaced (already cancelled) subscription can still hold pending future charges of this pair.
  await cancelUpcomingPayments(tx, scope, todayInBusinessTz(now), { now });
}
