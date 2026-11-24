import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { unlinkPatient } from '../../src/services/nutritionist-patient-service.js';
import {
  SubscriptionStatus,
  CANCELLATION_REASON_UNLINKED,
} from '../../src/constants/subscription.js';
import { PatientLinkStatus, NutritionMessageCode } from '../../src/constants/nutrition.js';
import { createUnlinkWorld } from '../helpers/unlink-world.js';
import {
  ServiceType,
  OWNER_USER_ID,
  OWNER_TRAINER_ID,
  OWNER_NUTRITIONIST_ID,
  expectedAssignmentLockKey,
} from '../helpers/subscription-owner-fixtures.js';

vi.mock('../../src/config/s3-bucket-handler.js', () => ({ default: { resolveUrl: vi.fn() } }));

const PATIENT_ID = 'patient-uuid-1';
const NOW = new Date('2026-06-11T02:00:00Z');
const NOT_FOUND = 404;
const OTHER_NUTRITIONIST_ID = 'other-nutritionist-uuid';

const mockPrisma = {
  nutritionistPatient: { findUnique: vi.fn(), update: vi.fn() },
  $transaction: vi.fn(),
};

// Builds an active subscription row for the patient.
function makeSubscription(id, serviceType, overrides = {}) {
  const onNutritionistRow = serviceType === ServiceType.NUTRITION;
  return {
    id,
    studentId: PATIENT_ID,
    serviceType,
    trainerId: onNutritionistRow ? null : OWNER_TRAINER_ID,
    nutritionistId: onNutritionistRow ? OWNER_NUTRITIONIST_ID : null,
    status: SubscriptionStatus.ACTIVE,
    ...overrides,
  };
}

// Builds a world for the unlink and wires it into the mocked transaction.
function setUpWorld({ subscriptions, trainerLinked = false, trainerId = OWNER_TRAINER_ID }) {
  const world = createUnlinkWorld({
    userId: OWNER_USER_ID,
    trainerId,
    nutritionistId: OWNER_NUTRITIONIST_ID,
    subscriptions,
    trainerLinked,
    patientLinked: true,
  });
  mockPrisma.$transaction.mockImplementation(world.runTransaction);
  return world;
}

// Runs the unlink as the owner user.
function unlink() {
  return unlinkPatient(mockPrisma, { nutritionistId: OWNER_NUTRITIONIST_ID, patientId: PATIENT_ID, userId: OWNER_USER_ID });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  mockPrisma.nutritionistPatient.findUnique.mockResolvedValue({ id: 'link-1', deletedAt: null });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('unlinkPatient billing cleanup (AC 10)', () => {
  it('should cancel an active nutrition subscription with reason unlinked and void its upcoming charges', async () => {
    const world = setUpWorld({ subscriptions: [makeSubscription('sub-nutrition', ServiceType.NUTRITION)] });

    await unlink();

    expect(world.cancelledIds()).toEqual(['sub-nutrition']);
    expect(world.subscription('sub-nutrition')).toMatchObject({
      status: SubscriptionStatus.CANCELLED,
      cancelledAt: NOW,
      cancellationReason: CANCELLATION_REASON_UNLINKED,
    });
    expect(world.voidedIds()).toEqual(['sub-nutrition']);
  });

  it('should keep a both subscription alive, with its charges, while the trainer link remains', async () => {
    const world = setUpWorld({
      subscriptions: [makeSubscription('sub-both', ServiceType.BOTH)],
      trainerLinked: true,
    });

    await unlink();

    expect(world.cancelledIds()).toEqual([]);
    expect(world.voidedIds()).toEqual([]);
  });

  it('should cancel a both subscription and void its charges when no trainer link remains', async () => {
    const world = setUpWorld({ subscriptions: [makeSubscription('sub-both', ServiceType.BOTH)] });

    await unlink();

    expect(world.cancelledIds()).toEqual(['sub-both']);
    expect(world.voidedIds()).toEqual(['sub-both']);
  });

  it('should leave a training subscription untouched even without a trainer link', async () => {
    const world = setUpWorld({ subscriptions: [makeSubscription('sub-training', ServiceType.TRAINING)] });

    await unlink();

    expect(world.cancelledIds()).toEqual([]);
    expect(world.voidedIds()).toEqual([]);
  });

  it('should only touch the unlinked patient and the unlinking professional', async () => {
    const world = setUpWorld({
      subscriptions: [
        makeSubscription('sub-mine', ServiceType.NUTRITION),
        makeSubscription('sub-other-patient', ServiceType.NUTRITION, { studentId: 'someone-else' }),
        makeSubscription('sub-other-nutritionist', ServiceType.NUTRITION, { nutritionistId: OTHER_NUTRITIONIST_ID }),
      ],
    });

    await unlink();

    expect(world.cancelledIds()).toEqual(['sub-mine']);
    expect(world.voidedIds()).toEqual(['sub-mine']);
  });

  it('should ignore subscriptions that are already cancelled', async () => {
    const world = setUpWorld({
      subscriptions: [makeSubscription('sub-old', ServiceType.NUTRITION, { status: SubscriptionStatus.CANCELLED })],
    });

    await unlink();

    expect(world.subscription('sub-old').cancellationReason).toBeUndefined();
  });
});

describe('unlinkPatient link and lock', () => {
  it('should soft-delete the link as inactive', async () => {
    const world = setUpWorld({ subscriptions: [] });

    await unlink();

    const call = (world.tx.nutritionistPatient.update.mock.calls[0] ?? world.tx.nutritionistPatient.updateMany.mock.calls[0])[0];
    expect(call.data).toMatchObject({ deletedAt: NOW, status: PatientLinkStatus.INACTIVE });
  });

  it('should take the blocking user-level advisory lock, the same key as assign, before any write', async () => {
    const world = setUpWorld({ subscriptions: [makeSubscription('sub-nutrition', ServiceType.NUTRITION)] });

    await unlink();

    expect(world.tx.$executeRaw).toHaveBeenCalledOnce();
    const [strings, lockKey] = world.tx.$executeRaw.mock.calls[0];
    expect(strings.join('?')).toContain('pg_advisory_xact_lock');
    expect(strings.join('?')).not.toContain('try');
    expect(lockKey).toBe(expectedAssignmentLockKey(OWNER_USER_ID, PATIENT_ID));
    const lockOrder = world.tx.$executeRaw.mock.invocationCallOrder[0];
    expect(lockOrder).toBeLessThan(world.tx.studentSubscription.updateMany.mock.invocationCallOrder[0]);
  });

  it('should answer 404 nutrition.patient.notFound and open no transaction when there is no active link', async () => {
    mockPrisma.nutritionistPatient.findUnique.mockResolvedValue(null);

    await expect(unlink()).rejects.toMatchObject({
      httpStatus: NOT_FOUND,
      messageCode: NutritionMessageCode.PATIENT_NOT_FOUND,
      error: expect.any(String),
      message: expect.any(String),
    });
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('should propagate a transaction failure', async () => {
    mockPrisma.$transaction.mockRejectedValue(new Error('tx failed'));

    await expect(unlink()).rejects.toThrow('tx failed');
  });
});
