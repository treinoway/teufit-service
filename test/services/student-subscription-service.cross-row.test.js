import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  CANCELLATION_REASON_REPLACED,
  ServiceType,
  SubscriptionStatus,
} from '../../src/constants/subscription.js';
import {
  assignPlanToStudent,
  getActiveSubscriptionByStudent,
} from '../../src/services/student-subscription-service.js';
import { assertStudentActiveOnPlan } from '../../src/services/platform-plan-service.js';
import { matchesWhere } from '../helpers/unlink-world.js';
import {
  OWNER_USER_ID,
  OWNER_TRAINER_ID,
  OWNER_NUTRITIONIST_ID,
  trainerOwner,
  nutritionistOwner,
  dualOwner,
} from '../helpers/subscription-owner-fixtures.js';

vi.mock('../../src/services/platform-plan-service.js', () => ({
  assertStudentActiveOnPlan: vi.fn(),
}));

const { Decimal } = Prisma;
const STUDENT_ID = 'student-uuid-1';
const PLAN_ID = 'plan-uuid-1';
const NOW = new Date('2026-05-01T15:00:00Z');
const START = { planId: PLAN_ID, startDate: '2026-05-01' };
const OTHER_TRAINER_ID = 'other-trainer-uuid';
const OTHER_NUTRITIONIST_ID = 'other-nutritionist-uuid';

let store;
let client;

// Orders rows by a Prisma-style orderBy list (array of single-key objects).
function sortByOrder(rows, orderBy = []) {
  const keys = orderBy.map((entry) => Object.entries(entry)[0]);
  return [...rows].sort((a, b) => {
    for (const [field, direction] of keys) {
      if (a[field] === b[field]) continue;
      const before = a[field] < b[field] ? -1 : 1;
      return direction === 'desc' ? -before : before;
    }
    return 0;
  });
}

// Builds a client whose subscription reads evaluate real where/orderBy against the in-memory store.
function makeClient() {
  const link = { id: 'link', deletedAt: null };
  const matching = ({ where, orderBy }) => sortByOrder(store.filter((row) => matchesWhere(row, where)), orderBy);
  return {
    $queryRaw: vi.fn().mockResolvedValue([{ locked: true }]),
    $executeRaw: vi.fn().mockResolvedValue(0),
    trainer: {
      findUnique: vi.fn().mockResolvedValue({ id: OWNER_TRAINER_ID }),
      findFirst: vi.fn().mockResolvedValue({ id: OWNER_TRAINER_ID }),
    },
    nutritionist: {
      findUnique: vi.fn().mockResolvedValue({ id: OWNER_NUTRITIONIST_ID }),
      findFirst: vi.fn().mockResolvedValue({ id: OWNER_NUTRITIONIST_ID }),
    },
    trainerStudent: { findFirst: vi.fn().mockResolvedValue(link), findUnique: vi.fn().mockResolvedValue(link) },
    nutritionistPatient: { findFirst: vi.fn().mockResolvedValue(link), findUnique: vi.fn().mockResolvedValue(link) },
    subscriptionPlan: { findFirst: vi.fn() },
    studentSubscription: {
      findMany: vi.fn(async (args) => matching(args)),
      findFirst: vi.fn(async (args) => matching(args)[0] ?? null),
      updateMany: vi.fn(async ({ where, data }) => {
        const matched = store.filter((row) => matchesWhere(row, where));
        matched.forEach((row) => Object.assign(row, data));
        return { count: matched.length };
      }),
      create: vi.fn(async ({ data }) => ({
        id: 'new-sub',
        createdAt: NOW,
        updatedAt: null,
        startDate: new Date('2026-05-01T12:00:00Z'),
        ...data,
      })),
    },
    subscriptionPayment: {
      create: vi.fn(async ({ data }) => ({
        id: 'new-payment',
        paidAt: null,
        notes: null,
        createdAt: NOW,
        updatedAt: null,
        ...data,
      })),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  };
}

// Builds a persisted subscription row of the given service type on the matching owner row.
function makeSubscription(id, serviceType, overrides = {}) {
  const onNutritionistRow = serviceType === ServiceType.NUTRITION;
  return {
    id,
    studentId: STUDENT_ID,
    serviceType,
    trainerId: onNutritionistRow ? null : OWNER_TRAINER_ID,
    nutritionistId: onNutritionistRow ? OWNER_NUTRITIONIST_ID : null,
    planId: PLAN_ID,
    recurrence: 'monthly',
    price: new Decimal('100.00'),
    discountPercent: null,
    discountAmount: null,
    billingDay: null,
    startDate: new Date('2026-04-01T12:00:00Z'),
    status: SubscriptionStatus.ACTIVE,
    cancelledAt: null,
    cancellationReason: null,
    createdAt: new Date('2026-04-01T00:00:00Z'),
    updatedAt: null,
    ...overrides,
  };
}

// Builds the plan row being assigned.
function makePlan(serviceType) {
  const onNutritionistRow = serviceType === ServiceType.NUTRITION;
  return {
    id: PLAN_ID,
    trainerId: onNutritionistRow ? null : OWNER_TRAINER_ID,
    nutritionistId: onNutritionistRow ? OWNER_NUTRITIONIST_ID : null,
    serviceType,
    name: 'Plano',
    recurrence: 'monthly',
    price: new Decimal('100.00'),
    discountPercent: null,
    discountAmount: null,
    billingDay: null,
    deletedAt: null,
  };
}

// Runs an assign of a plan of the given type as the given owner.
function assign(owner, serviceType) {
  client.subscriptionPlan.findFirst.mockResolvedValue(makePlan(serviceType));
  return assignPlanToStudent(client, owner, STUDENT_ID, START, NOW);
}

// Reads the current status of a stored subscription.
const statusOf = (id) => store.find((row) => row.id === id).status;

beforeEach(() => {
  store = [];
  client = makeClient();
  client.$transaction = vi.fn(async (callback) => callback(client));
  assertStudentActiveOnPlan.mockResolvedValue(undefined);
});

describe('assignPlanToStudent: one active subscription per professional user across both rows (m1)', () => {
  it('should replace the active nutrition subscription when a training plan is assigned through the trainer-only owner', async () => {
    store.push(makeSubscription('active-nutrition', ServiceType.NUTRITION));

    await assign(trainerOwner(), ServiceType.TRAINING);

    expect(statusOf('active-nutrition')).toBe(SubscriptionStatus.CANCELLED);
  });

  it('should mark the cross-row replacement with reason replaced', async () => {
    store.push(makeSubscription('active-nutrition', ServiceType.NUTRITION));

    await assign(trainerOwner(), ServiceType.TRAINING);

    expect(store[0]).toMatchObject({ cancellationReason: CANCELLATION_REASON_REPLACED, cancelledAt: NOW });
  });

  it('should void the replaced nutrition subscription upcoming charges through the trainer-only owner', async () => {
    store.push(makeSubscription('active-nutrition', ServiceType.NUTRITION));

    await assign(trainerOwner(), ServiceType.TRAINING);

    expect(client.subscriptionPayment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ subscription: { id: { in: ['active-nutrition'] } } }) }),
    );
  });

  it('should replace the active training subscription when a nutrition plan is assigned through the nutritionist-only owner', async () => {
    store.push(makeSubscription('active-training', ServiceType.TRAINING));

    await assign(nutritionistOwner(), ServiceType.NUTRITION);

    expect(statusOf('active-training')).toBe(SubscriptionStatus.CANCELLED);
  });

  it('should replace the active subscriptions of both rows when the dual owner assigns', async () => {
    store.push(
      makeSubscription('active-training', ServiceType.TRAINING),
      makeSubscription('active-nutrition', ServiceType.NUTRITION),
    );

    await assign(dualOwner(), ServiceType.TRAINING);

    expect([statusOf('active-training'), statusOf('active-nutrition')]).toEqual([
      SubscriptionStatus.CANCELLED,
      SubscriptionStatus.CANCELLED,
    ]);
  });

  it('should not replace an active subscription another professional holds with the same person', async () => {
    store.push(
      makeSubscription('theirs-training', ServiceType.TRAINING, { trainerId: OTHER_TRAINER_ID }),
      makeSubscription('theirs-nutrition', ServiceType.NUTRITION, { nutritionistId: OTHER_NUTRITIONIST_ID }),
    );

    await assign(trainerOwner(), ServiceType.TRAINING);

    expect([statusOf('theirs-training'), statusOf('theirs-nutrition')]).toEqual([
      SubscriptionStatus.ACTIVE,
      SubscriptionStatus.ACTIVE,
    ]);
  });

  it('should not replace an active subscription of the same user with another person', async () => {
    store.push(makeSubscription('other-person', ServiceType.NUTRITION, { studentId: 'student-uuid-2' }));

    await assign(trainerOwner(), ServiceType.TRAINING);

    expect(statusOf('other-person')).toBe(SubscriptionStatus.ACTIVE);
  });

  it('should still create the new subscription on the plan owner row only', async () => {
    store.push(makeSubscription('active-nutrition', ServiceType.NUTRITION));

    await assign(trainerOwner(), ServiceType.TRAINING);

    expect(client.studentSubscription.create.mock.calls[0][0].data).toMatchObject({
      trainerId: OWNER_TRAINER_ID,
      nutritionistId: null,
      serviceType: ServiceType.TRAINING,
    });
  });

  it('should keep the assignment lock keyed by the professional user', async () => {
    await assign(trainerOwner(), ServiceType.TRAINING);

    expect(client.$queryRaw.mock.calls[0].flat().join(' ')).toContain(
      `subscription-assign:user:${OWNER_USER_ID}:${STUDENT_ID}`,
    );
  });
});

describe('getActiveSubscriptionByStudent: deterministic pick across both rows (m1)', () => {
  it('should return the active subscription with the most recent startDate when both rows hold one', async () => {
    store.push(
      makeSubscription('older-start', ServiceType.TRAINING, { startDate: new Date('2026-03-01T12:00:00Z') }),
      makeSubscription('newer-start', ServiceType.NUTRITION, { startDate: new Date('2026-04-20T12:00:00Z') }),
    );

    const active = await getActiveSubscriptionByStudent(client, dualOwner(), STUDENT_ID);

    expect(active.id).toBe('newer-start');
  });

  it('should break a startDate tie with the most recent createdAt', async () => {
    const sameStart = new Date('2026-04-01T12:00:00Z');
    store.push(
      makeSubscription('created-last', ServiceType.NUTRITION, { startDate: sameStart, createdAt: new Date('2026-04-01T09:00:00Z') }),
      makeSubscription('created-first', ServiceType.TRAINING, { startDate: sameStart, createdAt: new Date('2026-04-01T08:00:00Z') }),
    );
    store.reverse();

    const active = await getActiveSubscriptionByStudent(client, dualOwner(), STUDENT_ID);

    expect(active.id).toBe('created-last');
  });

  it('should ignore cancelled subscriptions even when they start later', async () => {
    store.push(
      makeSubscription('cancelled-later', ServiceType.NUTRITION, {
        status: SubscriptionStatus.CANCELLED,
        startDate: new Date('2026-05-10T12:00:00Z'),
      }),
      makeSubscription('active-earlier', ServiceType.TRAINING),
    );

    const active = await getActiveSubscriptionByStudent(client, dualOwner(), STUDENT_ID);

    expect(active.id).toBe('active-earlier');
  });

  it('should order the lookup explicitly by startDate then createdAt descending', async () => {
    await getActiveSubscriptionByStudent(client, dualOwner(), STUDENT_ID);

    expect(client.studentSubscription.findFirst.mock.calls[0][0].orderBy).toEqual([
      { startDate: 'desc' },
      { createdAt: 'desc' },
    ]);
  });
});
