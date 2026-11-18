import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';
import { SubscriptionErrorCode } from '../../src/constants/subscription.js';
import {
  createPlan,
  listPlans,
  getPlanById,
  updatePlan,
  archivePlan,
  unarchivePlan,
} from '../../src/services/subscription-plan-service.js';
import {
  ServiceType,
  SERVICE_TYPE_NOT_ALLOWED_MESSAGE_CODE,
  OWNER_TRAINER_ID,
  OWNER_NUTRITIONIST_ID,
  trainerOwner,
  nutritionistOwner,
  dualOwner,
} from '../helpers/subscription-owner-fixtures.js';

const { Decimal } = Prisma;
const PLAN_ID = 'plan-uuid-1';
const UNPROCESSABLE = 422;
const BASE_PLAN = { name: 'Plano', recurrence: 'monthly', price: 100 };

const mockPrisma = {
  subscriptionPlan: {
    create: vi.fn(),
    findMany: vi.fn(),
    findFirst: vi.fn(),
    update: vi.fn(),
  },
  studentSubscription: { groupBy: vi.fn() },
};

// Builds a persisted plan row, owned by the trainer row unless overridden.
function makePlanRecord(overrides = {}) {
  return {
    id: PLAN_ID,
    trainerId: OWNER_TRAINER_ID,
    nutritionistId: null,
    serviceType: ServiceType.TRAINING,
    name: 'Plano',
    description: null,
    recurrence: 'monthly',
    price: new Decimal('100.00'),
    discountPercent: null,
    discountAmount: null,
    billingDay: null,
    deletedAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: null,
    ...overrides,
  };
}

// Echoes the create payload back as the persisted row.
function echoCreate() {
  mockPrisma.subscriptionPlan.create.mockImplementation(async ({ data }) => makePlanRecord(data));
}

beforeEach(() => {
  mockPrisma.studentSubscription.groupBy.mockResolvedValue([]);
  mockPrisma.subscriptionPlan.findMany.mockResolvedValue([]);
});

describe('createPlan with an owner object', () => {
  describe('nutritionist-only owner', () => {
    it('should default serviceType to nutrition and own the plan by the nutritionist row', async () => {
      echoCreate();

      const plan = await createPlan(mockPrisma, nutritionistOwner(), BASE_PLAN);

      const { data } = mockPrisma.subscriptionPlan.create.mock.calls[0][0];
      expect(data).toMatchObject({
        serviceType: ServiceType.NUTRITION,
        nutritionistId: OWNER_NUTRITIONIST_ID,
        trainerId: null,
      });
      expect(plan).toMatchObject({
        serviceType: ServiceType.NUTRITION,
        nutritionistId: OWNER_NUTRITIONIST_ID,
        trainerId: null,
      });
    });

    it('should reject a training plan with 422 serviceTypeNotAllowed and not persist', async () => {
      await expect(
        createPlan(mockPrisma, nutritionistOwner(), { ...BASE_PLAN, serviceType: ServiceType.TRAINING }),
      ).rejects.toMatchObject({ httpStatus: UNPROCESSABLE, messageCode: SERVICE_TYPE_NOT_ALLOWED_MESSAGE_CODE });
      expect(mockPrisma.subscriptionPlan.create).not.toHaveBeenCalled();
    });
  });

  describe('trainer-only owner', () => {
    it('should default serviceType to training and own the plan by the trainer row', async () => {
      echoCreate();

      await createPlan(mockPrisma, trainerOwner(), BASE_PLAN);

      const { data } = mockPrisma.subscriptionPlan.create.mock.calls[0][0];
      expect(data).toMatchObject({
        serviceType: ServiceType.TRAINING,
        trainerId: OWNER_TRAINER_ID,
        nutritionistId: null,
      });
    });

    it.each([ServiceType.NUTRITION, ServiceType.BOTH])(
      'should reject serviceType %s with 422 serviceTypeNotAllowed and not persist',
      async (serviceType) => {
        await expect(
          createPlan(mockPrisma, trainerOwner(), { ...BASE_PLAN, serviceType }),
        ).rejects.toMatchObject({
          httpStatus: UNPROCESSABLE,
          messageCode: SERVICE_TYPE_NOT_ALLOWED_MESSAGE_CODE,
          error: expect.any(String),
          message: expect.any(String),
        });
        expect(mockPrisma.subscriptionPlan.create).not.toHaveBeenCalled();
      },
    );
  });

  describe('dual-role owner', () => {
    it.each([
      [ServiceType.TRAINING, OWNER_TRAINER_ID, null],
      [ServiceType.BOTH, OWNER_TRAINER_ID, null],
      [ServiceType.NUTRITION, null, OWNER_NUTRITIONIST_ID],
    ])('should own a %s plan by trainerId=%s nutritionistId=%s', async (serviceType, trainerId, nutritionistId) => {
      echoCreate();

      await createPlan(mockPrisma, dualOwner(), { ...BASE_PLAN, serviceType });

      const { data } = mockPrisma.subscriptionPlan.create.mock.calls[0][0];
      expect(data).toMatchObject({ serviceType, trainerId, nutritionistId });
    });

    it('should default serviceType to training when none is sent', async () => {
      echoCreate();

      await createPlan(mockPrisma, dualOwner(), BASE_PLAN);

      expect(mockPrisma.subscriptionPlan.create.mock.calls[0][0].data.serviceType).toBe(ServiceType.TRAINING);
    });
  });

  it('should still validate discounts before persisting for a nutritionist owner', async () => {
    await expect(
      createPlan(mockPrisma, nutritionistOwner(), { ...BASE_PLAN, discountPercent: 10, discountAmount: 5 }),
    ).rejects.toMatchObject({ httpStatus: 400, error: SubscriptionErrorCode.BOTH_DISCOUNTS_SET });
    expect(mockPrisma.subscriptionPlan.create).not.toHaveBeenCalled();
  });
});

describe('listPlans with an owner object', () => {
  it('should scope a trainer-only owner to the trainer rows', async () => {
    await listPlans(mockPrisma, trainerOwner());

    expect(mockPrisma.subscriptionPlan.findMany.mock.calls[0][0].where).toMatchObject({
      trainerId: OWNER_TRAINER_ID,
      deletedAt: null,
    });
  });

  it('should scope a nutritionist-only owner to the nutritionist rows', async () => {
    await listPlans(mockPrisma, nutritionistOwner());

    expect(mockPrisma.subscriptionPlan.findMany.mock.calls[0][0].where).toMatchObject({
      nutritionistId: OWNER_NUTRITIONIST_ID,
      deletedAt: null,
    });
  });

  it('should scope a dual-role owner to the rows of either owner row', async () => {
    await listPlans(mockPrisma, dualOwner());

    const { where } = mockPrisma.subscriptionPlan.findMany.mock.calls[0][0];
    expect(where.deletedAt).toBeNull();
    expect(where.OR).toEqual(
      expect.arrayContaining([{ trainerId: OWNER_TRAINER_ID }, { nutritionistId: OWNER_NUTRITIONIST_ID }]),
    );
  });

  it('should return plans of all three service types for a dual-role owner with their tag and owner ids', async () => {
    mockPrisma.subscriptionPlan.findMany.mockResolvedValue([
      makePlanRecord({ id: 'p-training', serviceType: ServiceType.TRAINING }),
      makePlanRecord({ id: 'p-both', serviceType: ServiceType.BOTH }),
      makePlanRecord({
        id: 'p-nutrition',
        serviceType: ServiceType.NUTRITION,
        trainerId: null,
        nutritionistId: OWNER_NUTRITIONIST_ID,
      }),
    ]);

    const plans = await listPlans(mockPrisma, dualOwner());

    expect(plans.map((plan) => [plan.id, plan.serviceType, plan.trainerId, plan.nutritionistId])).toEqual([
      ['p-training', ServiceType.TRAINING, OWNER_TRAINER_ID, null],
      ['p-both', ServiceType.BOTH, OWNER_TRAINER_ID, null],
      ['p-nutrition', ServiceType.NUTRITION, null, OWNER_NUTRITIONIST_ID],
    ]);
  });
});

describe('plan lookups scoped by the owner', () => {
  it.each([
    ['getPlanById', (owner) => getPlanById(mockPrisma, owner, PLAN_ID)],
    ['updatePlan', (owner) => updatePlan(mockPrisma, owner, PLAN_ID, { name: 'y' })],
    ['archivePlan', (owner) => archivePlan(mockPrisma, owner, PLAN_ID)],
    ['unarchivePlan', (owner) => unarchivePlan(mockPrisma, owner, PLAN_ID)],
  ])('%s should answer 404 PLAN_NOT_FOUND for a plan outside the nutritionist scope', async (_name, call) => {
    mockPrisma.subscriptionPlan.findFirst.mockResolvedValue(null);

    await expect(call(nutritionistOwner())).rejects.toMatchObject({
      httpStatus: 404,
      error: SubscriptionErrorCode.PLAN_NOT_FOUND,
    });
    expect(mockPrisma.subscriptionPlan.findFirst.mock.calls[0][0].where).toEqual({
      id: PLAN_ID,
      nutritionistId: OWNER_NUTRITIONIST_ID,
    });
  });

  it('getPlanById should match a plan owned by either row of a dual-role owner', async () => {
    mockPrisma.subscriptionPlan.findFirst.mockResolvedValue(makePlanRecord());

    await getPlanById(mockPrisma, dualOwner(), PLAN_ID);

    const { where } = mockPrisma.subscriptionPlan.findFirst.mock.calls[0][0];
    expect(where.id).toBe(PLAN_ID);
    expect(where.OR).toEqual(
      expect.arrayContaining([{ trainerId: OWNER_TRAINER_ID }, { nutritionistId: OWNER_NUTRITIONIST_ID }]),
    );
  });

  it('updatePlan should reject a serviceType the trainer-only owner may not use with 422 and not update', async () => {
    mockPrisma.subscriptionPlan.findFirst.mockResolvedValue(makePlanRecord());

    await expect(
      updatePlan(mockPrisma, trainerOwner(), PLAN_ID, { serviceType: ServiceType.NUTRITION }),
    ).rejects.toMatchObject({ httpStatus: UNPROCESSABLE, messageCode: SERVICE_TYPE_NOT_ALLOWED_MESSAGE_CODE });
    expect(mockPrisma.subscriptionPlan.update).not.toHaveBeenCalled();
  });
});
