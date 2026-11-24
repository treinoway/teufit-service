import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';
import { ensureUpcomingCycles } from '../../src/services/subscription-cycle-service.js';
import { SubscriptionStatus, SubscriptionRecurrence } from '../../src/constants/subscription.js';
import {
  OWNER_TRAINER_ID,
  OWNER_NUTRITIONIST_ID,
  nutritionistOwner,
  trainerOwner,
  dualOwner,
} from '../helpers/subscription-owner-fixtures.js';

const { Decimal } = Prisma;
const TODAY = new Date('2026-06-10T00:00:00Z');
const VALUES_PER_ROW = 7;

const mockPrisma = {
  studentSubscription: { findMany: vi.fn() },
  $queryRaw: vi.fn(),
  $executeRaw: vi.fn(),
};

// Builds a nutritionist-owned active subscription row as the generator selects it.
function makeNutritionistSubscription(id) {
  return {
    id,
    startDate: new Date('2026-03-01T12:00:00Z'),
    recurrence: SubscriptionRecurrence.MONTHLY,
    price: new Decimal('100.00'),
    discountPercent: null,
    discountAmount: null,
    billingDay: null,
  };
}

// Builds the latest-cycle row the generator reads for a subscription.
function latestCycle(subscriptionId, cycleIndex, cycleEndDate) {
  return { subscriptionId, cycleIndex, cycleEndDate: new Date(`${cycleEndDate}T00:00:00Z`) };
}

// Subscription ids bound into the last cycle INSERT.
function insertedSubscriptionIds() {
  const joined = mockPrisma.$executeRaw.mock.calls.at(-1)[2];
  const ids = [];
  for (let offset = 0; offset < joined.values.length; offset += VALUES_PER_ROW) ids.push(joined.values[offset]);
  return ids;
}

beforeEach(() => {
  mockPrisma.$executeRaw.mockImplementation(async (_strings, _pending, joined) => joined.values.length / VALUES_PER_ROW);
  mockPrisma.studentSubscription.findMany.mockResolvedValue([]);
});

describe('ensureUpcomingCycles scoped by owner', () => {
  it('should scope a nutritionist-only owner to the nutritionist rows', async () => {
    await ensureUpcomingCycles(mockPrisma, { owner: nutritionistOwner(), today: TODAY });

    expect(mockPrisma.studentSubscription.findMany.mock.calls[0][0].where).toEqual({
      status: SubscriptionStatus.ACTIVE,
      nutritionistId: OWNER_NUTRITIONIST_ID,
    });
  });

  it('should scope a trainer-only owner to the trainer rows', async () => {
    await ensureUpcomingCycles(mockPrisma, { owner: trainerOwner(), today: TODAY });

    expect(mockPrisma.studentSubscription.findMany.mock.calls[0][0].where).toEqual({
      status: SubscriptionStatus.ACTIVE,
      trainerId: OWNER_TRAINER_ID,
    });
  });

  it('should scope a dual-role owner to the rows of either owner row', async () => {
    await ensureUpcomingCycles(mockPrisma, { owner: dualOwner(), today: TODAY });

    const { where } = mockPrisma.studentSubscription.findMany.mock.calls[0][0];
    expect(where.status).toBe(SubscriptionStatus.ACTIVE);
    expect(where.OR).toEqual(
      expect.arrayContaining([{ trainerId: OWNER_TRAINER_ID }, { nutritionistId: OWNER_NUTRITIONIST_ID }]),
    );
  });

  it('should keep honouring the trainerId option for existing callers', async () => {
    await ensureUpcomingCycles(mockPrisma, { trainerId: OWNER_TRAINER_ID, today: TODAY });

    expect(mockPrisma.studentSubscription.findMany.mock.calls[0][0].where).toEqual({
      status: SubscriptionStatus.ACTIVE,
      trainerId: OWNER_TRAINER_ID,
    });
  });
});

describe('ensureUpcomingCycles for the daily cron (AC 13)', () => {
  it('should not filter by any owner column', async () => {
    await ensureUpcomingCycles(mockPrisma, { today: TODAY });

    expect(mockPrisma.studentSubscription.findMany.mock.calls[0][0].where).toEqual({
      status: SubscriptionStatus.ACTIVE,
    });
  });

  it('should generate the next cycle of a due nutritionist subscription like a trainer one', async () => {
    mockPrisma.studentSubscription.findMany.mockResolvedValue([makeNutritionistSubscription('nutri-sub-1')]);
    mockPrisma.$queryRaw.mockResolvedValue([latestCycle('nutri-sub-1', 2, '2026-05-31')]);

    const result = await ensureUpcomingCycles(mockPrisma, { today: TODAY });

    expect(result).toEqual({ subscriptionsChecked: 1, cyclesCreated: 1 });
    expect(insertedSubscriptionIds()).toEqual(['nutri-sub-1']);
  });
});
