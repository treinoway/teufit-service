import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/db.js', () => ({
  prisma: {
    $transaction: vi.fn(),
    trainer: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
    },
    trainerStudent: {
      findUnique: vi.fn(),
      delete: vi.fn(),
    },
    trainerBriefingSnapshot: {
      updateMany: vi.fn(),
    },
  },
}));

vi.mock('../../src/services/platform-plan-service.js', () => ({
  assertStudentCap: vi.fn(),
}));

vi.mock('../../src/config/s3-bucket-handler.js', () => ({
  default: { resolveUrl: vi.fn() },
}));

vi.mock('../../src/services/challenge-participant-sync.js', () => ({
  joinAllModeChallenges: vi.fn(),
}));

vi.mock('../../src/config/email-handler.js', () => ({
  default: { sendStudentLinkedEmail: vi.fn() },
}));

import { prisma } from '../../src/db.js';
import { unlinkStudent } from '../../src/services/trainer-service.js';
import { createUnlinkWorld } from '../helpers/unlink-world.js';
import { ServiceType, expectedAssignmentLockKey } from '../helpers/subscription-owner-fixtures.js';
import { SubscriptionStatus, CANCELLATION_REASON_UNLINKED } from '../../src/constants/subscription.js';

const NOW = new Date('2026-06-11T02:00:00Z');
const TRAINER_ID = 'trainer1';
const TRAINER_USER_ID = 'trainer-user1';
const NUTRITIONIST_ID = 'nutritionist1';
const STUDENT_ID = 'student1';
const TRAINER_ROW = Object.freeze({ id: TRAINER_ID, userId: TRAINER_USER_ID, deletedAt: null });
const NUTRITIONIST_ROW = Object.freeze({ id: NUTRITIONIST_ID, userId: TRAINER_USER_ID, deletedAt: null });

// Prisma rejects `where: { userId: undefined }` on a unique lookup; the mock does the same.
function assertDefinedLookup(where, model) {
  const keys = Object.keys(where ?? {});
  if (keys.length === 0 || keys.some((key) => where[key] === undefined)) {
    throw new Error(`${model} lookup with an undefined where value (keys: ${keys.join(',') || 'none'})`);
  }
}

// Strict trainer lookup: finds the row only by its real id or its real userId.
async function findTrainerStrictly({ where }) {
  assertDefinedLookup(where, 'trainer');
  return where.id === TRAINER_ID || where.userId === TRAINER_USER_ID ? TRAINER_ROW : null;
}

// Strict nutritionist lookup: finds the row only by the trainer's real userId.
async function findNutritionistStrictly({ where }) {
  assertDefinedLookup(where, 'nutritionist');
  return where.userId === TRAINER_USER_ID ? NUTRITIONIST_ROW : null;
}

// Subscription row of the student, on the trainer row or the nutritionist row according to the tag.
function makeSubscription(id, serviceType) {
  const onNutritionistRow = serviceType === ServiceType.NUTRITION;
  return {
    id,
    studentId: STUDENT_ID,
    serviceType,
    trainerId: onNutritionistRow ? null : TRAINER_ID,
    nutritionistId: onNutritionistRow ? NUTRITIONIST_ID : null,
    status: SubscriptionStatus.ACTIVE,
  };
}

// In-memory unlink world whose trainer/nutritionist lookups really match on the where clause.
function setUpStrictWorld({ subscriptions, patientLinked = false }) {
  const world = createUnlinkWorld({
    userId: TRAINER_USER_ID,
    trainerId: TRAINER_ID,
    nutritionistId: NUTRITIONIST_ID,
    subscriptions,
    trainerLinked: true,
    patientLinked,
  });
  world.tx.trainer.findUnique.mockImplementation(findTrainerStrictly);
  world.tx.trainer.findFirst.mockImplementation(findTrainerStrictly);
  world.tx.nutritionist.findUnique.mockImplementation(findNutritionistStrictly);
  world.tx.nutritionist.findFirst.mockImplementation(findNutritionistStrictly);
  prisma.$transaction.mockImplementation(world.runTransaction);
  return world;
}

// Unlink as master's consistency-ranking e2e calls it: no userId.
function unlinkWithoutUser() {
  return unlinkStudent({ trainerId: TRAINER_ID, studentId: STUDENT_ID });
}

describe('unlinkStudent without userId (resolved from the trainer row)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    prisma.trainerStudent.findUnique.mockResolvedValue({ id: 'link1', trainerId: TRAINER_ID, studentId: STUDENT_ID });
    prisma.trainer.findUnique.mockImplementation(findTrainerStrictly);
    prisma.trainer.findFirst.mockImplementation(findTrainerStrictly);
    prisma.trainerBriefingSnapshot.updateMany.mockResolvedValue({ count: 0 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should resolve without throwing when userId is absent', async () => {
    setUpStrictWorld({ subscriptions: [makeSubscription('sub-training', ServiceType.TRAINING)] });

    await expect(unlinkWithoutUser()).resolves.toBeUndefined();
  });

  it('should take the advisory lock with the key built from the trainer row userId', async () => {
    const world = setUpStrictWorld({ subscriptions: [makeSubscription('sub-training', ServiceType.TRAINING)] });

    await unlinkWithoutUser();

    expect(world.tx.$executeRaw).toHaveBeenCalledOnce();
    const [, lockKey] = world.tx.$executeRaw.mock.calls[0];
    expect(lockKey).toBe(expectedAssignmentLockKey(TRAINER_USER_ID, STUDENT_ID));
  });

  it('should delete the link and cancel the training subscription, voiding its upcoming payments', async () => {
    const world = setUpStrictWorld({ subscriptions: [makeSubscription('sub-training', ServiceType.TRAINING)] });

    await unlinkWithoutUser();

    expect(world.tx.trainerStudent.delete).toHaveBeenCalledWith({
      where: { trainerId_studentId: { trainerId: TRAINER_ID, studentId: STUDENT_ID } },
    });
    expect(world.subscription('sub-training')).toMatchObject({
      status: SubscriptionStatus.CANCELLED,
      cancelledAt: NOW,
      cancellationReason: CANCELLATION_REASON_UNLINKED,
    });
    expect(world.voidedIds()).toEqual(['sub-training']);
  });

  it('should keep a both subscription alive while the same user still holds the patient link', async () => {
    const world = setUpStrictWorld({
      subscriptions: [makeSubscription('sub-both', ServiceType.BOTH)],
      patientLinked: true,
    });

    await unlinkWithoutUser();

    expect(world.cancelledIds()).toEqual([]);
    expect(world.voidedIds()).toEqual([]);
  });

  it('should leave a nutrition subscription of the same user untouched', async () => {
    const world = setUpStrictWorld({ subscriptions: [makeSubscription('sub-nutrition', ServiceType.NUTRITION)] });

    await unlinkWithoutUser();

    expect(world.cancelledIds()).toEqual([]);
    expect(world.voidedIds()).toEqual([]);
  });

  it('should still throw student.notLinked (404) before resolving anything when no link exists', async () => {
    prisma.trainerStudent.findUnique.mockResolvedValue(null);

    await expect(unlinkWithoutUser()).rejects.toMatchObject({
      error: 'NOT_FOUND',
      messageCode: 'student.notLinked',
      httpStatus: 404,
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('should behave the same as an unlink given the userId explicitly', async () => {
    const withoutUser = setUpStrictWorld({ subscriptions: [makeSubscription('sub-both', ServiceType.BOTH)] });
    await unlinkWithoutUser();
    const withUser = setUpStrictWorld({ subscriptions: [makeSubscription('sub-both', ServiceType.BOTH)] });
    await unlinkStudent({ trainerId: TRAINER_ID, studentId: STUDENT_ID, userId: TRAINER_USER_ID });

    expect(withoutUser.tx.$executeRaw.mock.calls[0][1]).toBe(withUser.tx.$executeRaw.mock.calls[0][1]);
    expect(withoutUser.cancelledIds()).toEqual(withUser.cancelledIds());
    expect(withoutUser.voidedIds()).toEqual(withUser.voidedIds());
  });
});
