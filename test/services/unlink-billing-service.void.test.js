import { describe, it, expect } from 'vitest';
import { cancelSubscriptionsAfterUnlink, UnlinkedProfessional } from '../../src/services/unlink-billing-service.js';
import { ServiceType, SubscriptionStatus } from '../../src/constants/subscription.js';
import { createUnlinkWorld } from '../helpers/unlink-world.js';
import {
  OWNER_USER_ID,
  OWNER_TRAINER_ID,
  OWNER_NUTRITIONIST_ID,
  dualOwner,
  trainerOwner,
  nutritionistOwner,
} from '../helpers/subscription-owner-fixtures.js';

const STUDENT_ID = 'student-uuid-1';
const OTHER_STUDENT_ID = 'student-uuid-2';
const OTHER_TRAINER_ID = 'other-trainer-uuid';
const OTHER_NUTRITIONIST_ID = 'other-nutritionist-uuid';
const NOW = new Date('2026-06-11T02:00:00Z');

// Builds a subscription row on the owner row the service type implies (nutrition on the nutritionist, the rest on the trainer).
function makeSubscription(id, serviceType, status, overrides = {}) {
  const onNutritionistRow = serviceType === ServiceType.NUTRITION;
  return {
    id,
    studentId: STUDENT_ID,
    serviceType,
    trainerId: onNutritionistRow ? null : OWNER_TRAINER_ID,
    nutritionistId: onNutritionistRow ? OWNER_NUTRITIONIST_ID : null,
    status,
    ...overrides,
  };
}

// Runs the billing cleanup for an unlink where the listed links remain, and returns the world.
async function runUnlink({ owner, unlinked, subscriptions, trainerLinked = false, patientLinked = false }) {
  const world = createUnlinkWorld({
    userId: OWNER_USER_ID,
    trainerId: owner.trainerId,
    nutritionistId: owner.nutritionistId,
    subscriptions,
    trainerLinked,
    patientLinked,
  });
  await cancelSubscriptionsAfterUnlink(world.tx, { owner, studentId: STUDENT_ID, unlinked, now: NOW });
  return world;
}

describe('cancelSubscriptionsAfterUnlink: voiding upcoming charges of already-cancelled subscriptions (M1)', () => {
  describe('trainer unlink', () => {
    const unlinked = UnlinkedProfessional.TRAINER;

    it('should void the upcoming charges of a replaced training subscription when no active subscription is cancelled', async () => {
      const world = await runUnlink({
        owner: trainerOwner(),
        unlinked,
        subscriptions: [makeSubscription('replaced-training', ServiceType.TRAINING, SubscriptionStatus.CANCELLED)],
      });

      expect(world.voidedIds()).toEqual(['replaced-training']);
    });

    it('should void both the newly cancelled and the already-cancelled training subscription', async () => {
      const world = await runUnlink({
        owner: trainerOwner(),
        unlinked,
        subscriptions: [
          makeSubscription('active-training', ServiceType.TRAINING, SubscriptionStatus.ACTIVE),
          makeSubscription('replaced-training', ServiceType.TRAINING, SubscriptionStatus.CANCELLED),
        ],
      });

      expect(world.voidedIds()).toEqual(['active-training', 'replaced-training']);
    });

    it('should void an already-cancelled both subscription when no patient link remains', async () => {
      const world = await runUnlink({
        owner: dualOwner(),
        unlinked,
        patientLinked: false,
        subscriptions: [makeSubscription('replaced-both', ServiceType.BOTH, SubscriptionStatus.CANCELLED)],
      });

      expect(world.voidedIds()).toEqual(['replaced-both']);
    });

    it('should not void an already-cancelled both subscription while the patient link remains', async () => {
      const world = await runUnlink({
        owner: dualOwner(),
        unlinked,
        patientLinked: true,
        subscriptions: [makeSubscription('replaced-both', ServiceType.BOTH, SubscriptionStatus.CANCELLED)],
      });

      expect(world.voidedIds()).toEqual([]);
    });

    it('should not void the charges of a cancelled nutrition subscription of the same user', async () => {
      const world = await runUnlink({
        owner: dualOwner(),
        unlinked,
        patientLinked: true,
        subscriptions: [makeSubscription('replaced-nutrition', ServiceType.NUTRITION, SubscriptionStatus.CANCELLED)],
      });

      expect(world.voidedIds()).toEqual([]);
    });

    it('should not void the charges of a cancelled subscription another trainer holds with the same person', async () => {
      const world = await runUnlink({
        owner: trainerOwner(),
        unlinked,
        subscriptions: [
          makeSubscription('theirs', ServiceType.TRAINING, SubscriptionStatus.CANCELLED, { trainerId: OTHER_TRAINER_ID }),
        ],
      });

      expect(world.voidedIds()).toEqual([]);
    });

    it('should not void the charges of a cancelled subscription of another person', async () => {
      const world = await runUnlink({
        owner: trainerOwner(),
        unlinked,
        subscriptions: [
          makeSubscription('other-person', ServiceType.TRAINING, SubscriptionStatus.CANCELLED, {
            studentId: OTHER_STUDENT_ID,
          }),
        ],
      });

      expect(world.voidedIds()).toEqual([]);
    });

    it('should not rewrite the cancellation data of an already-cancelled subscription', async () => {
      const world = await runUnlink({
        owner: trainerOwner(),
        unlinked,
        subscriptions: [makeSubscription('replaced-training', ServiceType.TRAINING, SubscriptionStatus.CANCELLED)],
      });

      expect(world.subscription('replaced-training').cancelledAt).toBeUndefined();
    });
  });

  describe('nutritionist unlink', () => {
    const unlinked = UnlinkedProfessional.NUTRITIONIST;

    it('should void the upcoming charges of a replaced nutrition subscription when no active subscription is cancelled', async () => {
      const world = await runUnlink({
        owner: nutritionistOwner(),
        unlinked,
        subscriptions: [makeSubscription('replaced-nutrition', ServiceType.NUTRITION, SubscriptionStatus.CANCELLED)],
      });

      expect(world.voidedIds()).toEqual(['replaced-nutrition']);
    });

    it('should void an already-cancelled both subscription when no trainer link remains', async () => {
      const world = await runUnlink({
        owner: dualOwner(),
        unlinked,
        trainerLinked: false,
        subscriptions: [makeSubscription('replaced-both', ServiceType.BOTH, SubscriptionStatus.CANCELLED)],
      });

      expect(world.voidedIds()).toEqual(['replaced-both']);
    });

    it('should not void an already-cancelled both subscription while the trainer link remains', async () => {
      const world = await runUnlink({
        owner: dualOwner(),
        unlinked,
        trainerLinked: true,
        subscriptions: [makeSubscription('replaced-both', ServiceType.BOTH, SubscriptionStatus.CANCELLED)],
      });

      expect(world.voidedIds()).toEqual([]);
    });

    it('should not void the charges of a cancelled training subscription of the same user', async () => {
      const world = await runUnlink({
        owner: dualOwner(),
        unlinked,
        trainerLinked: true,
        subscriptions: [makeSubscription('replaced-training', ServiceType.TRAINING, SubscriptionStatus.CANCELLED)],
      });

      expect(world.voidedIds()).toEqual([]);
    });

    it('should not void the charges of a cancelled subscription another nutritionist holds with the same person', async () => {
      const world = await runUnlink({
        owner: nutritionistOwner(),
        unlinked,
        subscriptions: [
          makeSubscription('theirs', ServiceType.NUTRITION, SubscriptionStatus.CANCELLED, {
            nutritionistId: OTHER_NUTRITIONIST_ID,
          }),
        ],
      });

      expect(world.voidedIds()).toEqual([]);
    });

    it('should void both the newly cancelled and the already-cancelled nutrition subscription', async () => {
      const world = await runUnlink({
        owner: nutritionistOwner(),
        unlinked,
        subscriptions: [
          makeSubscription('active-nutrition', ServiceType.NUTRITION, SubscriptionStatus.ACTIVE),
          makeSubscription('replaced-nutrition', ServiceType.NUTRITION, SubscriptionStatus.CANCELLED),
        ],
      });

      expect(world.voidedIds()).toEqual(['active-nutrition', 'replaced-nutrition']);
    });
  });
});
