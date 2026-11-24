import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  SubscriptionErrorCode,
  SubscriptionMessageCode,
  SubscriptionStatus,
  PaymentStatus,
  CANCELLATION_REASON_REPLACED,
} from '../../src/constants/subscription.js';
import {
  assignPlanToStudent,
  listSubscriptionsByStudent,
  getActiveSubscriptionByStudent,
  listSubscriptions,
  getSubscriptionById,
  cancelSubscription,
} from '../../src/services/student-subscription-service.js';
import { assertStudentActiveOnPlan } from '../../src/services/platform-plan-service.js';
import {
  ServiceType,
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
const SUBSCRIPTION_ID = 'sub-uuid-1';
const OLD_SUBSCRIPTION_ID = 'sub-uuid-old';
const FORBIDDEN = 403;
const NOW = new Date('2026-05-01T15:00:00Z');
const START = { planId: PLAN_ID, startDate: '2026-05-01' };

const mockTx = {
  $queryRaw: vi.fn(),
  $executeRaw: vi.fn(),
  trainer: { findUnique: vi.fn() },
  nutritionist: { findFirst: vi.fn() },
  trainerStudent: { findFirst: vi.fn(), findUnique: vi.fn() },
  nutritionistPatient: { findFirst: vi.fn(), findUnique: vi.fn() },
  studentSubscription: {
    findMany: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    updateMany: vi.fn(),
    create: vi.fn(),
  },
  subscriptionPayment: { create: vi.fn(), updateMany: vi.fn() },
};

const mockPrisma = {
  trainerStudent: { findFirst: vi.fn(), findUnique: vi.fn() },
  nutritionistPatient: { findFirst: vi.fn(), findUnique: vi.fn() },
  subscriptionPlan: { findFirst: vi.fn() },
  studentSubscription: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    updateMany: vi.fn(),
  },
  $transaction: vi.fn(),
};

// Builds a persisted plan row; trainerId/nutritionistId default to the trainer row.
function makePlan(serviceType, overrides = {}) {
  return {
    id: PLAN_ID,
    trainerId: serviceType === ServiceType.NUTRITION ? null : OWNER_TRAINER_ID,
    nutritionistId: serviceType === ServiceType.NUTRITION ? OWNER_NUTRITIONIST_ID : null,
    serviceType,
    name: 'Plano',
    recurrence: 'monthly',
    price: new Decimal('100.00'),
    discountPercent: null,
    discountAmount: null,
    billingDay: null,
    deletedAt: null,
    ...overrides,
  };
}

// Builds a persisted subscription row owned like the given plan.
function makeSubscription(serviceType, overrides = {}) {
  const plan = makePlan(serviceType);
  return {
    id: SUBSCRIPTION_ID,
    trainerId: plan.trainerId,
    nutritionistId: plan.nutritionistId,
    serviceType,
    studentId: STUDENT_ID,
    planId: PLAN_ID,
    recurrence: 'monthly',
    price: new Decimal('100.00'),
    discountPercent: null,
    discountAmount: null,
    billingDay: null,
    startDate: new Date('2026-05-01T12:00:00Z'),
    status: SubscriptionStatus.ACTIVE,
    cancelledAt: null,
    cancellationReason: null,
    createdAt: new Date('2026-05-01T00:00:00Z'),
    updatedAt: null,
    ...overrides,
  };
}

// Builds the first payment row returned by the create.
function makePayment() {
  return {
    id: 'payment-uuid-1',
    subscriptionId: SUBSCRIPTION_ID,
    cycleIndex: 0,
    cycleStartDate: new Date('2026-05-01T00:00:00Z'),
    cycleEndDate: new Date('2026-05-31T00:00:00Z'),
    dueDate: new Date('2026-05-01T00:00:00Z'),
    amount: new Decimal('100.00'),
    status: PaymentStatus.PENDING,
    paidAt: null,
    notes: null,
    createdAt: new Date('2026-05-01T00:00:00Z'),
    updatedAt: null,
  };
}

// Fakes which professional-student links are live, on a client; a soft-deleted patient link is invisible.
function stubLinks(client, { trainerLinked = false, patientLinked = false, patientLinkDeleted = false } = {}) {
  const trainerLink = trainerLinked ? { id: 'trainer-link' } : null;
  client.trainerStudent.findFirst.mockResolvedValue(trainerLink);
  client.trainerStudent.findUnique.mockResolvedValue(trainerLink);
  const patientLink = patientLinked ? { id: 'patient-link', deletedAt: patientLinkDeleted ? new Date() : null } : null;
  client.nutritionistPatient.findUnique.mockResolvedValue(patientLink);
  client.nutritionistPatient.findFirst.mockResolvedValue(patientLink && !patientLinkDeleted ? patientLink : null);
}

// Fakes the links on both the root client and the transaction client.
function stubAllLinks(links) {
  stubLinks(mockPrisma, links);
  stubLinks(mockTx, links);
}

// Runs assign with a plan of the given type and returns the create payload.
async function assignAndGetCreateData(owner, serviceType, links) {
  mockPrisma.subscriptionPlan.findFirst.mockResolvedValue(makePlan(serviceType));
  stubAllLinks(links);
  await assignPlanToStudent(mockPrisma, owner, STUDENT_ID, START, NOW);
  return mockTx.studentSubscription.create.mock.calls[0][0].data;
}

// Asserts the call is refused with 403 student.notLinked and nothing was written.
async function expectNotLinked(promise) {
  await expect(promise).rejects.toMatchObject({
    httpStatus: FORBIDDEN,
    error: SubscriptionErrorCode.STUDENT_NOT_LINKED,
    messageCode: SubscriptionMessageCode.STUDENT_NOT_LINKED,
    message: expect.any(String),
  });
  expect(mockTx.studentSubscription.create).not.toHaveBeenCalled();
  expect(mockTx.subscriptionPayment.create).not.toHaveBeenCalled();
}

beforeEach(() => {
  assertStudentActiveOnPlan.mockResolvedValue(undefined);
  mockPrisma.$transaction.mockImplementation(async (fn) => fn(mockTx));
  mockTx.$queryRaw.mockResolvedValue([{ locked: true }]);
  mockTx.$executeRaw.mockResolvedValue(0);
  mockTx.studentSubscription.findMany.mockResolvedValue([]);
  mockTx.studentSubscription.updateMany.mockResolvedValue({ count: 0 });
  mockTx.studentSubscription.create.mockImplementation(async ({ data }) => makeSubscription(data.serviceType, data));
  mockTx.subscriptionPayment.create.mockResolvedValue(makePayment());
  mockTx.subscriptionPayment.updateMany.mockResolvedValue({ count: 0 });
});

describe('assignPlanToStudent: nutritionist path (AC 4)', () => {
  it('should create the subscription owned by the nutritionist with the plan tag when a patient link exists', async () => {
    const data = await assignAndGetCreateData(nutritionistOwner(), ServiceType.NUTRITION, { patientLinked: true });

    expect(data).toMatchObject({
      nutritionistId: OWNER_NUTRITIONIST_ID,
      trainerId: null,
      serviceType: ServiceType.NUTRITION,
      studentId: STUDENT_ID,
      planId: PLAN_ID,
      status: SubscriptionStatus.ACTIVE,
    });
  });

  it('should create the first payment and return it with the subscription', async () => {
    mockPrisma.subscriptionPlan.findFirst.mockResolvedValue(makePlan(ServiceType.NUTRITION));
    stubAllLinks({ patientLinked: true });

    const result = await assignPlanToStudent(mockPrisma, nutritionistOwner(), STUDENT_ID, START, NOW);

    expect(mockTx.subscriptionPayment.create).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      id: SUBSCRIPTION_ID,
      nutritionistId: OWNER_NUTRITIONIST_ID,
      serviceType: ServiceType.NUTRITION,
      firstPayment: { status: PaymentStatus.PENDING },
    });
  });

  it('should skip the trainer seat quota', async () => {
    await assignAndGetCreateData(nutritionistOwner(), ServiceType.NUTRITION, { patientLinked: true });

    expect(assertStudentActiveOnPlan).not.toHaveBeenCalled();
  });

  it('should answer 403 student.notLinked without a transaction when there is no patient link', async () => {
    mockPrisma.subscriptionPlan.findFirst.mockResolvedValue(makePlan(ServiceType.NUTRITION));
    stubAllLinks({});

    await expectNotLinked(assignPlanToStudent(mockPrisma, nutritionistOwner(), STUDENT_ID, START, NOW));
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('should treat a soft-deleted patient link as not linked', async () => {
    mockPrisma.subscriptionPlan.findFirst.mockResolvedValue(makePlan(ServiceType.NUTRITION));
    stubAllLinks({ patientLinked: true, patientLinkDeleted: true });

    await expectNotLinked(assignPlanToStudent(mockPrisma, nutritionistOwner(), STUDENT_ID, START, NOW));
  });

  it('should re-check the patient link inside the transaction and write nothing when it vanished', async () => {
    mockPrisma.subscriptionPlan.findFirst.mockResolvedValue(makePlan(ServiceType.NUTRITION));
    stubLinks(mockPrisma, { patientLinked: true });
    stubLinks(mockTx, {});

    await expectNotLinked(assignPlanToStudent(mockPrisma, nutritionistOwner(), STUDENT_ID, START, NOW));
    expect(mockTx.studentSubscription.updateMany).not.toHaveBeenCalled();
  });

  it('should look the plan up inside the nutritionist scope', async () => {
    await assignAndGetCreateData(nutritionistOwner(), ServiceType.NUTRITION, { patientLinked: true });

    expect(mockPrisma.subscriptionPlan.findFirst.mock.calls[0][0].where).toEqual({
      id: PLAN_ID,
      nutritionistId: OWNER_NUTRITIONIST_ID,
    });
  });
});

describe('assignPlanToStudent: link rule per serviceType', () => {
  it('should require the trainer link for a training plan even when a patient link exists', async () => {
    mockPrisma.subscriptionPlan.findFirst.mockResolvedValue(makePlan(ServiceType.TRAINING));
    stubAllLinks({ patientLinked: true });

    await expectNotLinked(assignPlanToStudent(mockPrisma, dualOwner(), STUDENT_ID, START, NOW));
  });

  it('should require the patient link for a nutrition plan even when a trainer link exists', async () => {
    mockPrisma.subscriptionPlan.findFirst.mockResolvedValue(makePlan(ServiceType.NUTRITION));
    stubAllLinks({ trainerLinked: true });

    await expectNotLinked(assignPlanToStudent(mockPrisma, dualOwner(), STUDENT_ID, START, NOW));
  });

  it('should create a training subscription owned by the trainer when the trainer link exists', async () => {
    const data = await assignAndGetCreateData(dualOwner(), ServiceType.TRAINING, { trainerLinked: true });

    expect(data).toMatchObject({ trainerId: OWNER_TRAINER_ID, nutritionistId: null, serviceType: ServiceType.TRAINING });
  });

  it('should consume the trainer seat quota for a training plan', async () => {
    await assignAndGetCreateData(trainerOwner(), ServiceType.TRAINING, { trainerLinked: true });

    expect(assertStudentActiveOnPlan).toHaveBeenCalledWith(mockPrisma, OWNER_TRAINER_ID, STUDENT_ID);
  });

  describe('both plan (AC 5)', () => {
    it('should succeed for someone who is only a patient of the owner, owned by the trainer row', async () => {
      const data = await assignAndGetCreateData(dualOwner(), ServiceType.BOTH, { patientLinked: true });

      expect(data).toMatchObject({ trainerId: OWNER_TRAINER_ID, nutritionistId: null, serviceType: ServiceType.BOTH });
    });

    it('should succeed for someone who is only a student of the owner', async () => {
      const data = await assignAndGetCreateData(dualOwner(), ServiceType.BOTH, { trainerLinked: true });

      expect(data.serviceType).toBe(ServiceType.BOTH);
    });

    it('should answer 403 student.notLinked when neither link exists', async () => {
      mockPrisma.subscriptionPlan.findFirst.mockResolvedValue(makePlan(ServiceType.BOTH));
      stubAllLinks({});

      await expectNotLinked(assignPlanToStudent(mockPrisma, dualOwner(), STUDENT_ID, START, NOW));
    });

    it('should skip the trainer seat quota when the person is only a patient', async () => {
      await assignAndGetCreateData(dualOwner(), ServiceType.BOTH, { patientLinked: true });

      expect(assertStudentActiveOnPlan).not.toHaveBeenCalled();
    });

    it('should consume the trainer seat quota when the person is a student of the trainer', async () => {
      await assignAndGetCreateData(dualOwner(), ServiceType.BOTH, { trainerLinked: true });

      expect(assertStudentActiveOnPlan).toHaveBeenCalledWith(mockPrisma, OWNER_TRAINER_ID, STUDENT_ID);
    });
  });
});

describe('assignPlanToStudent: replacement and lock across both owner rows (AC 7)', () => {
  it('should look for active subscriptions of the user through either owner row', async () => {
    await assignAndGetCreateData(dualOwner(), ServiceType.TRAINING, { trainerLinked: true });

    const { where } = mockTx.studentSubscription.findMany.mock.calls[0][0];
    expect(where).toMatchObject({ studentId: STUDENT_ID, status: SubscriptionStatus.ACTIVE });
    expect(where.OR).toEqual(
      expect.arrayContaining([{ trainerId: OWNER_TRAINER_ID }, { nutritionistId: OWNER_NUTRITIONIST_ID }]),
    );
  });

  it('should cancel an active nutrition subscription with reason replaced before creating the new training one', async () => {
    mockTx.studentSubscription.findMany.mockResolvedValue([
      { ...makeSubscription(ServiceType.NUTRITION, { id: OLD_SUBSCRIPTION_ID }) },
    ]);

    await assignAndGetCreateData(dualOwner(), ServiceType.TRAINING, { trainerLinked: true });

    expect(mockTx.studentSubscription.updateMany).toHaveBeenCalledWith({
      where: { id: { in: [OLD_SUBSCRIPTION_ID] } },
      data: {
        status: SubscriptionStatus.CANCELLED,
        cancelledAt: NOW,
        cancellationReason: CANCELLATION_REASON_REPLACED,
      },
    });
    expect(mockTx.studentSubscription.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      mockTx.studentSubscription.create.mock.invocationCallOrder[0],
    );
  });

  it('should void the replaced subscription upcoming payments', async () => {
    mockTx.studentSubscription.findMany.mockResolvedValue([makeSubscription(ServiceType.NUTRITION, { id: OLD_SUBSCRIPTION_ID })]);

    await assignAndGetCreateData(dualOwner(), ServiceType.TRAINING, { trainerLinked: true });

    expect(mockTx.subscriptionPayment.updateMany.mock.calls[0][0].where.subscription).toEqual({
      id: { in: [OLD_SUBSCRIPTION_ID] },
    });
  });

  it('should take the user-level advisory lock regardless of the owner row of the plan', async () => {
    await assignAndGetCreateData(dualOwner(), ServiceType.NUTRITION, { patientLinked: true });

    const [strings, lockKey] = mockTx.$queryRaw.mock.calls[0];
    expect(strings.join('?')).toContain('pg_try_advisory_xact_lock');
    expect(lockKey).toBe(`subscription-assign:user:${OWNER_USER_ID}:${STUDENT_ID}`);
  });

  it('should answer 409 SUBSCRIPTION_ALREADY_ACTIVE when the user-level lock is held', async () => {
    mockPrisma.subscriptionPlan.findFirst.mockResolvedValue(makePlan(ServiceType.NUTRITION));
    stubAllLinks({ patientLinked: true });
    mockTx.$queryRaw.mockResolvedValue([{ locked: false }]);

    await expect(assignPlanToStudent(mockPrisma, dualOwner(), STUDENT_ID, START, NOW)).rejects.toMatchObject({
      httpStatus: 409,
      error: SubscriptionErrorCode.SUBSCRIPTION_ALREADY_ACTIVE,
      messageCode: SubscriptionMessageCode.SUBSCRIPTION_ALREADY_ACTIVE,
    });
    expect(mockTx.studentSubscription.create).not.toHaveBeenCalled();
  });

  it('should map a nutritionist-pair unique violation to 409 SUBSCRIPTION_ALREADY_ACTIVE', async () => {
    mockPrisma.subscriptionPlan.findFirst.mockResolvedValue(makePlan(ServiceType.NUTRITION));
    stubAllLinks({ patientLinked: true });
    mockPrisma.$transaction.mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' }));

    await expect(assignPlanToStudent(mockPrisma, nutritionistOwner(), STUDENT_ID, START, NOW)).rejects.toMatchObject({
      httpStatus: 409,
      error: SubscriptionErrorCode.SUBSCRIPTION_ALREADY_ACTIVE,
    });
  });
});

describe('subscription reads and cancel scoped by the owner', () => {
  it('listSubscriptionsByStudent should scope a nutritionist-only owner to the nutritionist rows', async () => {
    mockPrisma.studentSubscription.findMany.mockResolvedValue([makeSubscription(ServiceType.NUTRITION)]);

    const list = await listSubscriptionsByStudent(mockPrisma, nutritionistOwner(), STUDENT_ID);

    expect(mockPrisma.studentSubscription.findMany.mock.calls[0][0].where).toEqual({
      nutritionistId: OWNER_NUTRITIONIST_ID,
      studentId: STUDENT_ID,
    });
    expect(list[0]).toMatchObject({ serviceType: ServiceType.NUTRITION, nutritionistId: OWNER_NUTRITIONIST_ID });
  });

  it('listSubscriptionsByStudent should cover both owner rows of a dual-role owner', async () => {
    mockPrisma.studentSubscription.findMany.mockResolvedValue([]);

    await listSubscriptionsByStudent(mockPrisma, dualOwner(), STUDENT_ID);

    const { where } = mockPrisma.studentSubscription.findMany.mock.calls[0][0];
    expect(where.studentId).toBe(STUDENT_ID);
    expect(where.OR).toEqual(
      expect.arrayContaining([{ trainerId: OWNER_TRAINER_ID }, { nutritionistId: OWNER_NUTRITIONIST_ID }]),
    );
  });

  it('listSubscriptions should keep the status and plan filters next to the owner scope', async () => {
    mockPrisma.studentSubscription.findMany.mockResolvedValue([]);

    await listSubscriptions(mockPrisma, nutritionistOwner(), { status: SubscriptionStatus.ACTIVE, planId: PLAN_ID });

    expect(mockPrisma.studentSubscription.findMany.mock.calls[0][0].where).toEqual({
      nutritionistId: OWNER_NUTRITIONIST_ID,
      status: SubscriptionStatus.ACTIVE,
      planId: PLAN_ID,
    });
  });

  it('getSubscriptionById should answer 404 SUBSCRIPTION_NOT_FOUND outside the owner scope', async () => {
    mockPrisma.studentSubscription.findFirst.mockResolvedValue(null);

    await expect(getSubscriptionById(mockPrisma, nutritionistOwner(), SUBSCRIPTION_ID)).rejects.toMatchObject({
      httpStatus: 404,
      error: SubscriptionErrorCode.SUBSCRIPTION_NOT_FOUND,
    });
    expect(mockPrisma.studentSubscription.findFirst.mock.calls[0][0].where).toEqual({
      id: SUBSCRIPTION_ID,
      nutritionistId: OWNER_NUTRITIONIST_ID,
    });
  });

  it('getActiveSubscriptionByStudent should accept a patient link for a nutritionist-only owner', async () => {
    stubLinks(mockPrisma, { patientLinked: true });
    mockPrisma.studentSubscription.findFirst.mockResolvedValue(makeSubscription(ServiceType.NUTRITION));

    const active = await getActiveSubscriptionByStudent(mockPrisma, nutritionistOwner(), STUDENT_ID);

    expect(active).toMatchObject({ id: SUBSCRIPTION_ID, serviceType: ServiceType.NUTRITION });
    expect(mockPrisma.studentSubscription.findFirst.mock.calls[0][0].where).toMatchObject({
      nutritionistId: OWNER_NUTRITIONIST_ID,
      studentId: STUDENT_ID,
      status: SubscriptionStatus.ACTIVE,
    });
  });

  it('getActiveSubscriptionByStudent should answer 403 student.notLinked for a nutritionist-only owner without a patient link', async () => {
    stubLinks(mockPrisma, { trainerLinked: true });

    await expect(getActiveSubscriptionByStudent(mockPrisma, nutritionistOwner(), STUDENT_ID)).rejects.toMatchObject({
      httpStatus: FORBIDDEN,
      messageCode: SubscriptionMessageCode.STUDENT_NOT_LINKED,
    });
  });

  it('getActiveSubscriptionByStudent should accept either link for a dual-role owner', async () => {
    stubLinks(mockPrisma, { patientLinked: true });
    mockPrisma.studentSubscription.findFirst.mockResolvedValue(null);

    await expect(getActiveSubscriptionByStudent(mockPrisma, dualOwner(), STUDENT_ID)).resolves.toBeNull();
  });

  it('cancelSubscription should answer 404 for a subscription of another professional', async () => {
    mockPrisma.studentSubscription.findFirst.mockResolvedValue(null);

    await expect(cancelSubscription(mockPrisma, nutritionistOwner(), SUBSCRIPTION_ID, {}, NOW)).rejects.toMatchObject({
      httpStatus: 404,
      error: SubscriptionErrorCode.SUBSCRIPTION_NOT_FOUND,
    });
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });
});
