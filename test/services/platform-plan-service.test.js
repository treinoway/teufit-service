import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import config from '../../config/index.js';
import { PLAN_LIMITS, PLATFORM_PLAN_ERRORS, getBillingMonth } from '../../src/constants/platform-plan.js';

// ─── Prisma mock ───────────────────────────────────────────────────────────────

const mockPrisma = {
  platformSubscription: { findUnique: vi.fn(), update: vi.fn() },
  trainerStudent: {
    count: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
    updateMany: vi.fn(),
  },
  aiUsageEvent: { count: vi.fn(), create: vi.fn(), groupBy: vi.fn() },
  trainer: { findUnique: vi.fn() },
  account: { findFirst: vi.fn() },
  user: { findUnique: vi.fn() },
};

import {
  getTrainerPlan,
  assertStudentCap,
  assertCanUseBranding,
  assertCanCreateChallenge,
  assertCanUseAi,
  recordAiAction,
  assertStudentActiveOnPlan,
  enforceStudentCapAfterDowngrade,
  reactivateStudentsUpToCap,
  buildPlatformPlanForMe,
} from '../../src/services/platform-plan-service.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const TRAINER_ID = 'trainer-uuid-1';
const STUDENT_ID = 'student-uuid-1';
const STUDENT_ID_2 = 'student-uuid-2';

function makeSubscription(tier, overrides = {}) {
  return {
    id: 'sub-uuid-1',
    trainerId: TRAINER_ID,
    tier,
    status: 'ACTIVE',
    asaasCustomerId: null,
    asaasSubscriptionId: null,
    currentPeriodStart: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    trialEndsAt: null,
    pastDueSince: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function expectPlanError(errorDef) {
  return expect.objectContaining({
    error: errorDef.code,
    messageCode: errorDef.messageCode,
    httpStatus: errorDef.status,
  });
}

// ─── getTrainerPlan ────────────────────────────────────────────────────────────

describe('getTrainerPlan', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns FREE defaults when no subscription row exists', async () => {
    mockPrisma.platformSubscription.findUnique.mockResolvedValue(null);

    const result = await getTrainerPlan(mockPrisma, TRAINER_ID);

    expect(result).toEqual({
      tier: 'FREE',
      status: 'ACTIVE',
      limits: PLAN_LIMITS.FREE,
      subscription: null,
    });
  });

  it.each([['FREE'], ['PRO'], ['PLATINUM'], ['DIAMOND']])(
    'returns correct tier and limits for %s subscription',
    async (tier) => {
      mockPrisma.platformSubscription.findUnique.mockResolvedValue(makeSubscription(tier));

      const result = await getTrainerPlan(mockPrisma, TRAINER_ID);

      expect(result.tier).toBe(tier);
      expect(result.limits).toEqual(PLAN_LIMITS[tier]);
      expect(result.subscription).toBeDefined();
    }
  );

  it('returns FREE limits defensively for unknown tier in DB', async () => {
    mockPrisma.platformSubscription.findUnique.mockResolvedValue(
      makeSubscription('UNKNOWN_TIER')
    );

    const result = await getTrainerPlan(mockPrisma, TRAINER_ID);

    expect(result.limits).toEqual(PLAN_LIMITS.FREE);
  });

  describe('past-due grace period check', () => {
    afterEach(() => vi.useRealTimers());

    it('downgrades to FREE when PAST_DUE and pastDueSince is 8 days ago', async () => {
      const now = new Date('2026-05-16T12:00:00Z');
      vi.useFakeTimers({ now });

      const pastDueSince = new Date('2026-05-08T12:00:00Z'); // 8 days ago
      mockPrisma.platformSubscription.findUnique.mockResolvedValue(
        makeSubscription('PRO', { status: 'PAST_DUE', pastDueSince })
      );
      mockPrisma.platformSubscription.update.mockResolvedValue({});
      // enforceStudentCapAfterDowngrade will call getTrainerPlan again (now FREE/ACTIVE)
      mockPrisma.platformSubscription.findUnique
        .mockResolvedValueOnce(makeSubscription('PRO', { status: 'PAST_DUE', pastDueSince }))
        .mockResolvedValueOnce(makeSubscription('FREE', { status: 'ACTIVE', pastDueSince: null }));
      mockPrisma.trainerStudent.findMany.mockResolvedValue([]);

      const result = await getTrainerPlan(mockPrisma, TRAINER_ID);

      expect(result.tier).toBe('FREE');
      expect(result.status).toBe('ACTIVE');
      expect(mockPrisma.platformSubscription.update).toHaveBeenCalledWith({
        where: { trainerId: TRAINER_ID },
        data: expect.objectContaining({ tier: 'FREE', status: 'ACTIVE' }),
      });
    });

    it('does NOT downgrade when PAST_DUE and pastDueSince is only 3 days ago', async () => {
      const now = new Date('2026-05-16T12:00:00Z');
      vi.useFakeTimers({ now });

      const pastDueSince = new Date('2026-05-13T12:00:00Z'); // 3 days ago
      mockPrisma.platformSubscription.findUnique.mockResolvedValue(
        makeSubscription('PRO', { status: 'PAST_DUE', pastDueSince })
      );

      const result = await getTrainerPlan(mockPrisma, TRAINER_ID);

      expect(result.tier).toBe('PRO');
      expect(result.status).toBe('PAST_DUE');
      expect(mockPrisma.platformSubscription.update).not.toHaveBeenCalled();
    });

    it('skips grace check when pastDueSince is null', async () => {
      mockPrisma.platformSubscription.findUnique.mockResolvedValue(
        makeSubscription('PRO', { status: 'PAST_DUE', pastDueSince: null })
      );

      const result = await getTrainerPlan(mockPrisma, TRAINER_ID);

      expect(result.tier).toBe('PRO');
      expect(mockPrisma.platformSubscription.update).not.toHaveBeenCalled();
    });

    it('does not trigger grace check for ACTIVE subscription', async () => {
      mockPrisma.platformSubscription.findUnique.mockResolvedValue(
        makeSubscription('PRO', { status: 'ACTIVE', pastDueSince: null })
      );

      const result = await getTrainerPlan(mockPrisma, TRAINER_ID);

      expect(result.tier).toBe('PRO');
      expect(mockPrisma.platformSubscription.update).not.toHaveBeenCalled();
    });
  });
});

// ─── assertStudentCap ─────────────────────────────────────────────────────────

describe('assertStudentCap', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('FREE tier (cap = 3)', () => {
    beforeEach(() => {
      mockPrisma.platformSubscription.findUnique.mockResolvedValue(makeSubscription('FREE'));
    });

    it('does not throw when 0 active students', async () => {
      mockPrisma.trainerStudent.count.mockResolvedValue(0);
      await expect(assertStudentCap(mockPrisma, TRAINER_ID)).resolves.toBeUndefined();
    });

    it('does not throw when 2 active students', async () => {
      mockPrisma.trainerStudent.count.mockResolvedValue(2);
      await expect(assertStudentCap(mockPrisma, TRAINER_ID)).resolves.toBeUndefined();
    });

    it('throws STUDENT_CAP_EXCEEDED when exactly at cap (3/3)', async () => {
      mockPrisma.trainerStudent.count.mockResolvedValue(3);
      await expect(assertStudentCap(mockPrisma, TRAINER_ID)).rejects.toMatchObject(
        expectPlanError(PLATFORM_PLAN_ERRORS.STUDENT_CAP_EXCEEDED)
      );
    });

    it('throws STUDENT_CAP_EXCEEDED when over cap (4/3)', async () => {
      mockPrisma.trainerStudent.count.mockResolvedValue(4);
      await expect(assertStudentCap(mockPrisma, TRAINER_ID)).rejects.toMatchObject(
        expectPlanError(PLATFORM_PLAN_ERRORS.STUDENT_CAP_EXCEEDED)
      );
    });
  });

  describe('PRO tier (cap = 20)', () => {
    beforeEach(() => {
      mockPrisma.platformSubscription.findUnique.mockResolvedValue(makeSubscription('PRO'));
    });

    it('does not throw when 19 active students', async () => {
      mockPrisma.trainerStudent.count.mockResolvedValue(19);
      await expect(assertStudentCap(mockPrisma, TRAINER_ID)).resolves.toBeUndefined();
    });

    it('throws STUDENT_CAP_EXCEEDED when exactly at cap (20/20)', async () => {
      mockPrisma.trainerStudent.count.mockResolvedValue(20);
      await expect(assertStudentCap(mockPrisma, TRAINER_ID)).rejects.toMatchObject(
        expectPlanError(PLATFORM_PLAN_ERRORS.STUDENT_CAP_EXCEEDED)
      );
    });
  });

  describe('PLATINUM tier (cap = 80)', () => {
    beforeEach(() => {
      mockPrisma.platformSubscription.findUnique.mockResolvedValue(makeSubscription('PLATINUM'));
    });

    it('does not throw when 79 active students', async () => {
      mockPrisma.trainerStudent.count.mockResolvedValue(79);
      await expect(assertStudentCap(mockPrisma, TRAINER_ID)).resolves.toBeUndefined();
    });

    it('throws STUDENT_CAP_EXCEEDED when exactly at cap (80/80)', async () => {
      mockPrisma.trainerStudent.count.mockResolvedValue(80);
      await expect(assertStudentCap(mockPrisma, TRAINER_ID)).rejects.toMatchObject(
        expectPlanError(PLATFORM_PLAN_ERRORS.STUDENT_CAP_EXCEEDED)
      );
    });
  });

  describe('DIAMOND tier (cap = Infinity)', () => {
    beforeEach(() => {
      mockPrisma.platformSubscription.findUnique.mockResolvedValue(makeSubscription('DIAMOND'));
    });

    it('does not throw even with 999 active students and skips DB count', async () => {
      await expect(assertStudentCap(mockPrisma, TRAINER_ID)).resolves.toBeUndefined();
      expect(mockPrisma.trainerStudent.count).not.toHaveBeenCalled();
    });
  });
});

// ─── assertCanUseBranding ─────────────────────────────────────────────────────

describe('assertCanUseBranding', () => {
  beforeEach(() => vi.clearAllMocks());

  it('throws BRANDING_NOT_AVAILABLE for FREE', async () => {
    mockPrisma.platformSubscription.findUnique.mockResolvedValue(makeSubscription('FREE'));
    await expect(assertCanUseBranding(mockPrisma, TRAINER_ID)).rejects.toMatchObject(
      expectPlanError(PLATFORM_PLAN_ERRORS.BRANDING_NOT_AVAILABLE)
    );
  });

  it.each([['PRO'], ['PLATINUM'], ['DIAMOND']])(
    'does not throw for %s',
    async (tier) => {
      mockPrisma.platformSubscription.findUnique.mockResolvedValue(makeSubscription(tier));
      await expect(assertCanUseBranding(mockPrisma, TRAINER_ID)).resolves.toBeUndefined();
    }
  );
});

// ─── assertCanCreateChallenge ─────────────────────────────────────────────────

describe('assertCanCreateChallenge', () => {
  beforeEach(() => vi.clearAllMocks());

  it('throws CHAMPIONSHIPS_NOT_AVAILABLE for FREE', async () => {
    mockPrisma.platformSubscription.findUnique.mockResolvedValue(makeSubscription('FREE'));
    await expect(assertCanCreateChallenge(mockPrisma, TRAINER_ID)).rejects.toMatchObject(
      expectPlanError(PLATFORM_PLAN_ERRORS.CHAMPIONSHIPS_NOT_AVAILABLE)
    );
  });

  it.each([['PRO'], ['PLATINUM'], ['DIAMOND']])(
    'does not throw for %s',
    async (tier) => {
      mockPrisma.platformSubscription.findUnique.mockResolvedValue(makeSubscription(tier));
      await expect(assertCanCreateChallenge(mockPrisma, TRAINER_ID)).resolves.toBeUndefined();
    }
  );
});

// ─── assertCanUseAi ───────────────────────────────────────────────────────────

describe('assertCanUseAi', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.trainer.findUnique.mockResolvedValue({ userId: 'trainer-user-1' });
    mockPrisma.account.findFirst.mockResolvedValue({ id: 'account-1' });
  });

  describe('when the trainer email is unverified', () => {
    beforeEach(() => {
      mockPrisma.account.findFirst.mockResolvedValue(null);
      mockPrisma.aiUsageEvent.count.mockResolvedValue(0);
      mockPrisma.user.findUnique.mockResolvedValue({ createdAt: new Date(config.emailVerification.enforcedFrom) });
    });

    it('does not refuse an account created before the open-signup cut-off', async () => {
      mockPrisma.platformSubscription.findUnique.mockResolvedValue(makeSubscription('BETA'));
      mockPrisma.user.findUnique.mockResolvedValue({ createdAt: new Date(new Date(config.emailVerification.enforcedFrom).getTime() - 1) });

      await expect(assertCanUseAi(mockPrisma, TRAINER_ID, STUDENT_ID)).resolves.toBeUndefined();
      expect(mockPrisma.user.findUnique).toHaveBeenCalledWith({ where: { id: 'trainer-user-1' }, select: { createdAt: true } });
    });

    it('throws 403 EMAIL_VERIFICATION_REQUIRED on a plan that allows AI', async () => {
      mockPrisma.platformSubscription.findUnique.mockResolvedValue(makeSubscription('BETA'));

      await expect(assertCanUseAi(mockPrisma, TRAINER_ID, STUDENT_ID)).rejects.toMatchObject({
        httpStatus: 403,
        error: 'EMAIL_VERIFICATION_REQUIRED',
        messageCode: 'emailVerification.required',
      });
      expect(mockPrisma.account.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: 'trainer-user-1', verifiedAt: { not: null } } }),
      );
    });

    it('answers the plan error first when the plan has no AI', async () => {
      mockPrisma.platformSubscription.findUnique.mockResolvedValue(makeSubscription('FREE'));

      await expect(assertCanUseAi(mockPrisma, TRAINER_ID, STUDENT_ID)).rejects.toMatchObject(
        expectPlanError(PLATFORM_PLAN_ERRORS.AI_NOT_AVAILABLE)
      );
      expect(mockPrisma.account.findFirst).not.toHaveBeenCalled();
    });

    it('answers the usage cap error first when the cap is reached', async () => {
      mockPrisma.platformSubscription.findUnique.mockResolvedValue(makeSubscription('PRO'));
      mockPrisma.aiUsageEvent.count.mockResolvedValue(3);

      await expect(assertCanUseAi(mockPrisma, TRAINER_ID, STUDENT_ID)).rejects.toMatchObject({
        error: PLATFORM_PLAN_ERRORS.AI_ACTIONS_EXCEEDED.code,
      });
    });
  });

  it('throws EMAIL_VERIFICATION_REQUIRED without an account lookup when the trainer row is missing', async () => {
    mockPrisma.platformSubscription.findUnique.mockResolvedValue(makeSubscription('BETA'));
    mockPrisma.aiUsageEvent.count.mockResolvedValue(0);
    mockPrisma.trainer.findUnique.mockResolvedValue(null);

    await expect(assertCanUseAi(mockPrisma, TRAINER_ID, STUDENT_ID)).rejects.toMatchObject({
      error: 'EMAIL_VERIFICATION_REQUIRED',
    });
    expect(mockPrisma.account.findFirst).not.toHaveBeenCalled();
  });

  it('throws AI_NOT_AVAILABLE for FREE without any DB count call', async () => {
    mockPrisma.platformSubscription.findUnique.mockResolvedValue(makeSubscription('FREE'));
    await expect(assertCanUseAi(mockPrisma, TRAINER_ID, STUDENT_ID)).rejects.toMatchObject(
      expectPlanError(PLATFORM_PLAN_ERRORS.AI_NOT_AVAILABLE)
    );
    expect(mockPrisma.aiUsageEvent.count).not.toHaveBeenCalled();
  });

  describe('PRO tier (aiActionsPerStudent = 3, aiActionsTrainerCap = null)', () => {
    beforeEach(() => {
      mockPrisma.platformSubscription.findUnique.mockResolvedValue(makeSubscription('PRO'));
    });

    it('does not throw when student has 0/3 used', async () => {
      mockPrisma.aiUsageEvent.count.mockResolvedValue(0);
      await expect(assertCanUseAi(mockPrisma, TRAINER_ID, STUDENT_ID)).resolves.toBeUndefined();
    });

    it('does not throw when student has 2/3 used', async () => {
      mockPrisma.aiUsageEvent.count.mockResolvedValue(2);
      await expect(assertCanUseAi(mockPrisma, TRAINER_ID, STUDENT_ID)).resolves.toBeUndefined();
    });

    it('throws AI_ACTIONS_EXCEEDED with correct details when student is at 3/3', async () => {
      mockPrisma.aiUsageEvent.count.mockResolvedValue(3);
      await expect(assertCanUseAi(mockPrisma, TRAINER_ID, STUDENT_ID)).rejects.toMatchObject({
        error: PLATFORM_PLAN_ERRORS.AI_ACTIONS_EXCEEDED.code,
        messageCode: PLATFORM_PLAN_ERRORS.AI_ACTIONS_EXCEEDED.messageCode,
        httpStatus: PLATFORM_PLAN_ERRORS.AI_ACTIONS_EXCEEDED.status,
        details: { used: 3, remaining: 0, cap: 3, scope: 'student' },
      });
    });

    it('throws for first student at cap but not for second student at 0', async () => {
      mockPrisma.platformSubscription.findUnique
        .mockResolvedValueOnce(makeSubscription('PRO'))
        .mockResolvedValueOnce(makeSubscription('PRO'));

      mockPrisma.aiUsageEvent.count
        .mockResolvedValueOnce(3);

      await expect(assertCanUseAi(mockPrisma, TRAINER_ID, STUDENT_ID)).rejects.toMatchObject(
        expectPlanError(PLATFORM_PLAN_ERRORS.AI_ACTIONS_EXCEEDED)
      );

      mockPrisma.aiUsageEvent.count.mockResolvedValueOnce(0);
      await expect(assertCanUseAi(mockPrisma, TRAINER_ID, STUDENT_ID_2)).resolves.toBeUndefined();
    });

    it('skips per-student and trainer-wide checks when studentId is null', async () => {
      await expect(assertCanUseAi(mockPrisma, TRAINER_ID, null)).resolves.toBeUndefined();
      expect(mockPrisma.aiUsageEvent.count).not.toHaveBeenCalled();
    });
  });

  describe('PLATINUM tier (aiActionsPerStudent = 3, aiActionsTrainerCap = null)', () => {
    beforeEach(() => {
      mockPrisma.platformSubscription.findUnique.mockResolvedValue(makeSubscription('PLATINUM'));
    });

    it('does not throw when student has 2/3 used', async () => {
      mockPrisma.aiUsageEvent.count.mockResolvedValue(2);
      await expect(assertCanUseAi(mockPrisma, TRAINER_ID, STUDENT_ID)).resolves.toBeUndefined();
    });

    it('throws AI_ACTIONS_EXCEEDED when student is at 3/3', async () => {
      mockPrisma.aiUsageEvent.count.mockResolvedValue(3);
      await expect(assertCanUseAi(mockPrisma, TRAINER_ID, STUDENT_ID)).rejects.toMatchObject(
        expectPlanError(PLATFORM_PLAN_ERRORS.AI_ACTIONS_EXCEEDED)
      );
    });
  });

  describe('DIAMOND tier (aiActionsPerStudent = Infinity, aiActionsTrainerCap = 1000)', () => {
    beforeEach(() => {
      mockPrisma.platformSubscription.findUnique.mockResolvedValue(makeSubscription('DIAMOND'));
    });

    it('does not throw when trainer-wide usage is 999/1000', async () => {
      mockPrisma.aiUsageEvent.count.mockResolvedValue(999);
      await expect(assertCanUseAi(mockPrisma, TRAINER_ID, STUDENT_ID)).resolves.toBeUndefined();
    });

    it('throws AI_ACTIONS_EXCEEDED with trainer scope when trainer-wide usage is 1000/1000', async () => {
      mockPrisma.aiUsageEvent.count.mockResolvedValue(1000);
      await expect(assertCanUseAi(mockPrisma, TRAINER_ID, STUDENT_ID)).rejects.toMatchObject({
        error: PLATFORM_PLAN_ERRORS.AI_ACTIONS_EXCEEDED.code,
        messageCode: PLATFORM_PLAN_ERRORS.AI_ACTIONS_EXCEEDED.messageCode,
        httpStatus: PLATFORM_PLAN_ERRORS.AI_ACTIONS_EXCEEDED.status,
        details: expect.objectContaining({ scope: 'trainer' }),
      });
    });

    it('skips per-student check (Infinity limit) and only runs trainer-wide check', async () => {
      mockPrisma.aiUsageEvent.count.mockResolvedValue(500);
      await expect(assertCanUseAi(mockPrisma, TRAINER_ID, STUDENT_ID)).resolves.toBeUndefined();

      expect(mockPrisma.aiUsageEvent.count).toHaveBeenCalledTimes(1);
      const callArgs = mockPrisma.aiUsageEvent.count.mock.calls[0][0];
      expect(callArgs.where).not.toHaveProperty('studentId');
    });
  });
});

// ─── recordAiAction ───────────────────────────────────────────────────────────

describe('recordAiAction', () => {
  beforeEach(() => vi.clearAllMocks());

  it('inserts an AiUsageEvent with correct billingMonth for current UTC date', async () => {
    mockPrisma.aiUsageEvent.create.mockResolvedValue({});
    const action = 'reorder_exercises';
    const expectedMonth = getBillingMonth();

    await recordAiAction(mockPrisma, TRAINER_ID, STUDENT_ID, action);

    expect(mockPrisma.aiUsageEvent.create).toHaveBeenCalledOnce();
    expect(mockPrisma.aiUsageEvent.create).toHaveBeenCalledWith({
      data: {
        trainerId: TRAINER_ID,
        studentId: STUDENT_ID,
        action,
        billingMonth: expectedMonth,
      },
    });
  });

  it('sets studentId to null when not provided', async () => {
    mockPrisma.aiUsageEvent.create.mockResolvedValue({});

    await recordAiAction(mockPrisma, TRAINER_ID, null, 'generate_workout');

    expect(mockPrisma.aiUsageEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ studentId: null }),
    });
  });

  it('billingMonth format is YYYY-MM', async () => {
    mockPrisma.aiUsageEvent.create.mockResolvedValue({});
    await recordAiAction(mockPrisma, TRAINER_ID, STUDENT_ID, 'test_action');

    const { billingMonth } = mockPrisma.aiUsageEvent.create.mock.calls[0][0].data;
    expect(billingMonth).toMatch(/^\d{4}-\d{2}$/);
  });
});

// ─── assertStudentActiveOnPlan ────────────────────────────────────────────────

describe('assertStudentActiveOnPlan', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does not throw when activeOnPlan is true', async () => {
    mockPrisma.trainerStudent.findUnique.mockResolvedValue({ activeOnPlan: true });
    await expect(
      assertStudentActiveOnPlan(mockPrisma, TRAINER_ID, STUDENT_ID)
    ).resolves.toBeUndefined();
  });

  it('throws STUDENT_BLOCKED_ON_PLAN with studentId when activeOnPlan is false', async () => {
    mockPrisma.trainerStudent.findUnique.mockResolvedValue({ activeOnPlan: false });
    await expect(
      assertStudentActiveOnPlan(mockPrisma, TRAINER_ID, STUDENT_ID)
    ).rejects.toMatchObject({
      error: PLATFORM_PLAN_ERRORS.STUDENT_BLOCKED_ON_PLAN.code,
      messageCode: PLATFORM_PLAN_ERRORS.STUDENT_BLOCKED_ON_PLAN.messageCode,
      httpStatus: PLATFORM_PLAN_ERRORS.STUDENT_BLOCKED_ON_PLAN.status,
      details: { studentId: STUDENT_ID },
    });
  });

  it('throws STUDENT_BLOCKED_ON_PLAN when link not found (null)', async () => {
    mockPrisma.trainerStudent.findUnique.mockResolvedValue(null);
    await expect(
      assertStudentActiveOnPlan(mockPrisma, TRAINER_ID, STUDENT_ID)
    ).rejects.toMatchObject(
      expectPlanError(PLATFORM_PLAN_ERRORS.STUDENT_BLOCKED_ON_PLAN)
    );
  });

  it('queries with compound key trainerId_studentId', async () => {
    mockPrisma.trainerStudent.findUnique.mockResolvedValue({ activeOnPlan: true });
    await assertStudentActiveOnPlan(mockPrisma, TRAINER_ID, STUDENT_ID);

    expect(mockPrisma.trainerStudent.findUnique).toHaveBeenCalledWith({
      where: { trainerId_studentId: { trainerId: TRAINER_ID, studentId: STUDENT_ID } },
      select: { activeOnPlan: true },
    });
  });
});

// ─── buildPlatformPlanForMe ───────────────────────────────────────────────────

describe('buildPlatformPlanForMe', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns FREE plan shape with correct defaults when no subscription exists', async () => {
    mockPrisma.platformSubscription.findUnique.mockResolvedValue(null);
    mockPrisma.trainerStudent.count
      .mockResolvedValueOnce(1)  // active students
      .mockResolvedValueOnce(0); // blocked students
    mockPrisma.aiUsageEvent.groupBy.mockResolvedValue([]);

    const result = await buildPlatformPlanForMe(mockPrisma, TRAINER_ID);

    expect(result.tier).toBe('FREE');
    expect(result.status).toBe('ACTIVE');
    expect(result.currentPeriodEnd).toBeNull();
    expect(result.cancelAtPeriodEnd).toBe(false);
    expect(result.limits).toEqual({
      studentCap: 3,
      aiActionsPerStudent: 0,
      aiActionsTrainerCap: 0,
      branding: false,
      championships: false,
    });
    expect(result.usage.students).toEqual({ active: 1, blocked: 0, cap: 3 });
    expect(result.usage.aiActions).toEqual({ total: 0, byStudent: [] });
  });

  it('returns PLATINUM plan with correct usage when trainer has students and AI events', async () => {
    mockPrisma.platformSubscription.findUnique.mockResolvedValue(makeSubscription('PLATINUM', {
      currentPeriodEnd: new Date('2026-06-16T00:00:00Z'),
    }));
    mockPrisma.trainerStudent.count
      .mockResolvedValueOnce(50)  // active
      .mockResolvedValueOnce(0);  // blocked
    mockPrisma.aiUsageEvent.groupBy.mockResolvedValue([
      { studentId: 'student-uuid-1', _count: { _all: 2 } },
      { studentId: 'student-uuid-2', _count: { _all: 2 } },
      { studentId: 'student-uuid-3', _count: { _all: 1 } },
    ]);

    const result = await buildPlatformPlanForMe(mockPrisma, TRAINER_ID);

    expect(result.tier).toBe('PLATINUM');
    expect(result.limits.studentCap).toBe(80);
    expect(result.limits.aiActionsPerStudent).toBe(3);
    expect(result.limits.aiActionsTrainerCap).toBeNull(); // null for PLATINUM (no trainer cap)
    expect(result.usage.students.active).toBe(50);
    expect(result.usage.students.blocked).toBe(0);
    expect(result.usage.students.cap).toBe(80);
    expect(result.usage.aiActions.total).toBe(5);
    expect(result.usage.aiActions.byStudent).toHaveLength(3);
    expect(result.usage.aiActions.byStudent[0]).toEqual({ studentId: 'student-uuid-1', count: 2 });
  });

  it('converts Infinity limits to null for DIAMOND tier', async () => {
    mockPrisma.platformSubscription.findUnique.mockResolvedValue(makeSubscription('DIAMOND', {
      currentPeriodEnd: new Date('2026-06-16T00:00:00Z'),
    }));
    mockPrisma.trainerStudent.count
      .mockResolvedValueOnce(200) // active
      .mockResolvedValueOnce(0);  // blocked
    mockPrisma.aiUsageEvent.groupBy.mockResolvedValue([]);

    const result = await buildPlatformPlanForMe(mockPrisma, TRAINER_ID);

    expect(result.tier).toBe('DIAMOND');
    expect(result.limits.studentCap).toBeNull(); // Infinity → null
    expect(result.limits.aiActionsPerStudent).toBeNull(); // Infinity → null
    expect(result.limits.aiActionsTrainerCap).toBe(1000); // finite value preserved
    expect(result.usage.students.cap).toBeNull(); // Infinity → null
  });

  it('counts blocked students separately from active students', async () => {
    mockPrisma.platformSubscription.findUnique.mockResolvedValue(makeSubscription('PRO'));
    mockPrisma.trainerStudent.count
      .mockResolvedValueOnce(18)  // active
      .mockResolvedValueOnce(5);  // blocked (exceeded cap after downgrade)
    mockPrisma.aiUsageEvent.groupBy.mockResolvedValue([]);

    const result = await buildPlatformPlanForMe(mockPrisma, TRAINER_ID);

    expect(result.usage.students.active).toBe(18);
    expect(result.usage.students.blocked).toBe(5);
    expect(result.usage.students.cap).toBe(20);
  });

  it('queries active count with activeOnPlan: true and blocked with activeOnPlan: false', async () => {
    mockPrisma.platformSubscription.findUnique.mockResolvedValue(makeSubscription('PRO'));
    mockPrisma.trainerStudent.count.mockResolvedValue(0);
    mockPrisma.aiUsageEvent.groupBy.mockResolvedValue([]);

    await buildPlatformPlanForMe(mockPrisma, TRAINER_ID);

    const calls = mockPrisma.trainerStudent.count.mock.calls;
    expect(calls[0][0].where).toEqual({ trainerId: TRAINER_ID, activeOnPlan: true });
    expect(calls[1][0].where).toEqual({ trainerId: TRAINER_ID, activeOnPlan: false });
  });

  it('queries AI usage by billingMonth matching current UTC month', async () => {
    mockPrisma.platformSubscription.findUnique.mockResolvedValue(makeSubscription('PRO'));
    mockPrisma.trainerStudent.count.mockResolvedValue(0);
    mockPrisma.aiUsageEvent.groupBy.mockResolvedValue([]);

    await buildPlatformPlanForMe(mockPrisma, TRAINER_ID);

    const [groupByCall] = mockPrisma.aiUsageEvent.groupBy.mock.calls;
    expect(groupByCall[0].where.billingMonth).toMatch(/^\d{4}-\d{2}$/);
    expect(groupByCall[0].where.trainerId).toBe(TRAINER_ID);
    expect(groupByCall[0].by).toContain('studentId');
  });

  it('includes currentPeriodEnd from subscription when present', async () => {
    const periodEnd = new Date('2026-07-01T00:00:00Z');
    mockPrisma.platformSubscription.findUnique.mockResolvedValue(
      makeSubscription('PRO', { currentPeriodEnd: periodEnd, cancelAtPeriodEnd: true })
    );
    mockPrisma.trainerStudent.count.mockResolvedValue(0);
    mockPrisma.aiUsageEvent.groupBy.mockResolvedValue([]);

    const result = await buildPlatformPlanForMe(mockPrisma, TRAINER_ID);

    expect(result.currentPeriodEnd).toEqual(periodEnd);
    expect(result.cancelAtPeriodEnd).toBe(true);
  });
});

// ─── enforceStudentCapAfterDowngrade ──────────────────────────────────────────

describe('enforceStudentCapAfterDowngrade', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns immediately for DIAMOND without any DB calls', async () => {
    mockPrisma.platformSubscription.findUnique.mockResolvedValue(makeSubscription('DIAMOND'));

    await enforceStudentCapAfterDowngrade(mockPrisma, TRAINER_ID);

    expect(mockPrisma.trainerStudent.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.trainerStudent.updateMany).not.toHaveBeenCalled();
  });

  it('blocks the 30 oldest students when downgraded to PRO with 50 active', async () => {
    mockPrisma.platformSubscription.findUnique.mockResolvedValue(makeSubscription('PRO'));

    const fiftyStudents = Array.from({ length: 50 }, (_, i) => ({
      trainerId: TRAINER_ID,
      studentId: `student-uuid-${i + 1}`,
    }));
    mockPrisma.trainerStudent.findMany.mockResolvedValue(fiftyStudents);
    mockPrisma.trainerStudent.updateMany.mockResolvedValue({ count: 30 });

    await enforceStudentCapAfterDowngrade(mockPrisma, TRAINER_ID);

    expect(mockPrisma.trainerStudent.updateMany).toHaveBeenCalledOnce();
    const { where, data } = mockPrisma.trainerStudent.updateMany.mock.calls[0][0];
    expect(where.studentId.in).toHaveLength(30);
    expect(where.studentId.in).toEqual(fiftyStudents.slice(0, 30).map((s) => s.studentId));
    expect(data).toEqual({ activeOnPlan: false });
  });

  it('is idempotent — does not call updateMany when already at cap (20/20 for PRO)', async () => {
    mockPrisma.platformSubscription.findUnique.mockResolvedValue(makeSubscription('PRO'));

    const twentyStudents = Array.from({ length: 20 }, (_, i) => ({
      trainerId: TRAINER_ID,
      studentId: `student-uuid-${i + 1}`,
    }));
    mockPrisma.trainerStudent.findMany.mockResolvedValue(twentyStudents);

    await enforceStudentCapAfterDowngrade(mockPrisma, TRAINER_ID);

    expect(mockPrisma.trainerStudent.updateMany).not.toHaveBeenCalled();
  });

  it('does not block when active count is below cap (10 active, PRO cap 20)', async () => {
    mockPrisma.platformSubscription.findUnique.mockResolvedValue(makeSubscription('PRO'));

    const tenStudents = Array.from({ length: 10 }, (_, i) => ({
      trainerId: TRAINER_ID,
      studentId: `student-uuid-${i + 1}`,
    }));
    mockPrisma.trainerStudent.findMany.mockResolvedValue(tenStudents);

    await enforceStudentCapAfterDowngrade(mockPrisma, TRAINER_ID);

    expect(mockPrisma.trainerStudent.updateMany).not.toHaveBeenCalled();
  });
});

// ─── reactivateStudentsUpToCap ─────────────────────────────────────────────────

describe('reactivateStudentsUpToCap', () => {
  beforeEach(() => vi.clearAllMocks());

  function stubStudentLinks({ activeIds = [], blockedIds = [] }) {
    const toLink = (studentId, activeOnPlan, index) => ({
      trainerId: TRAINER_ID,
      studentId,
      activeOnPlan,
      createdAt: new Date(2026, 0, index + 1),
    });
    const active = activeIds.map((id, i) => toLink(id, true, i));
    const blocked = blockedIds.map((id, i) => toLink(id, false, i));

    mockPrisma.trainerStudent.findMany.mockImplementation(async ({ where } = {}) => {
      if (where?.activeOnPlan === true) return active;
      if (where?.activeOnPlan === false) return blocked;
      return [...active, ...blocked];
    });
    mockPrisma.trainerStudent.count.mockImplementation(async ({ where } = {}) => {
      if (where?.activeOnPlan === true) return active.length;
      if (where?.activeOnPlan === false) return blocked.length;
      return active.length + blocked.length;
    });
    mockPrisma.trainerStudent.updateMany.mockResolvedValue({ count: 0 });
  }

  function ids(prefix, count) {
    return Array.from({ length: count }, (_, i) => `${prefix}-${i + 1}`);
  }

  it('reactivates the oldest blocked students first, up to the free slots under the cap', async () => {
    mockPrisma.platformSubscription.findUnique.mockResolvedValue(makeSubscription('PRO'));
    const activeIds = ids('active', PLAN_LIMITS.PRO.studentCap - 2);
    stubStudentLinks({ activeIds, blockedIds: ['blocked-oldest', 'blocked-middle', 'blocked-newest'] });

    await reactivateStudentsUpToCap(mockPrisma, TRAINER_ID);

    expect(mockPrisma.trainerStudent.updateMany).toHaveBeenCalledOnce();
    expect(mockPrisma.trainerStudent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          trainerId: TRAINER_ID,
          studentId: { in: ['blocked-oldest', 'blocked-middle'] },
        }),
        data: { activeOnPlan: true },
      })
    );
  });

  it('queries blocked students ordered by createdAt ascending', async () => {
    mockPrisma.platformSubscription.findUnique.mockResolvedValue(makeSubscription('PRO'));
    stubStudentLinks({ activeIds: [], blockedIds: ['blocked-1'] });

    await reactivateStudentsUpToCap(mockPrisma, TRAINER_ID);

    const blockedQuery = mockPrisma.trainerStudent.findMany.mock.calls
      .map(([args]) => args)
      .find((args) => args?.where?.activeOnPlan === false);
    expect(blockedQuery.orderBy).toEqual({ createdAt: 'asc' });
  });

  it('reactivates every blocked student on DIAMOND (unlimited cap)', async () => {
    mockPrisma.platformSubscription.findUnique.mockResolvedValue(makeSubscription('DIAMOND'));
    const blockedIds = ids('blocked', PLAN_LIMITS.PLATINUM.studentCap + 5);
    stubStudentLinks({ activeIds: ids('active', 10), blockedIds });

    await reactivateStudentsUpToCap(mockPrisma, TRAINER_ID);

    expect(mockPrisma.trainerStudent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ studentId: { in: blockedIds } }),
        data: { activeOnPlan: true },
      })
    );
  });

  it('does nothing when the trainer is already at the cap', async () => {
    mockPrisma.platformSubscription.findUnique.mockResolvedValue(makeSubscription('PRO'));
    stubStudentLinks({
      activeIds: ids('active', PLAN_LIMITS.PRO.studentCap),
      blockedIds: ['blocked-1', 'blocked-2'],
    });

    await reactivateStudentsUpToCap(mockPrisma, TRAINER_ID);

    expect(mockPrisma.trainerStudent.updateMany).not.toHaveBeenCalled();
  });

  it('does nothing when there are no blocked students', async () => {
    mockPrisma.platformSubscription.findUnique.mockResolvedValue(makeSubscription('PRO'));
    stubStudentLinks({ activeIds: ids('active', 3), blockedIds: [] });

    await reactivateStudentsUpToCap(mockPrisma, TRAINER_ID);

    expect(mockPrisma.trainerStudent.updateMany).not.toHaveBeenCalled();
  });
});
