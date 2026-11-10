import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/config/s3-bucket-handler.js', () => ({
  default: { resolveUrl: vi.fn(async (key) => (key ? `https://cdn/${key}` : null)) },
}));

import {
  getToday,
  setMealLog,
  undoMealLog,
  setSwap,
  undoSwap,
  addWater,
} from '../../src/services/nutrition-today-service.js';
import { maxWaterMl } from '../../src/helpers/nutrition-today.js';
import { DEFAULT_WATER_TARGET_ML, MealLogStatus, NutritionErrorCode, NutritionMessageCode } from '../../src/constants/nutrition.js';

const PATIENT_ID = 'patient-1';
const PLAN_ID = 'plan-1';
const DATE = '2026-11-02';
const DATE_KEY = new Date('2026-11-02T00:00:00.000Z');
const WATER_TARGET_ML = 2000;
const HTTP_NOT_FOUND = 404;
const HTTP_UNPROCESSABLE = 422;
const NOW = new Date('2026-11-02T15:00:00.000Z');
const LONG_AGO = new Date('2026-09-01T12:00:00.000Z');
const PUBLISHED_TODAY = new Date('2026-11-02T12:00:00.000Z');
const TOMORROW = '2026-11-03';
const AFTER_TOMORROW = '2026-11-04';
const BEFORE_PUBLICATION = '2026-11-01';

// Test helper: build the published snapshot of the plan.
function makeSnapshot() {
  const substitute = { id: 'sub-1', name: 'Torrada', householdMeasure: null, quantity: 80, nutrients: {} };
  const item = {
    id: 'item-1',
    name: 'Pão',
    householdMeasure: null,
    quantity: 100,
    unit: 'g',
    nutrients: {},
    substitutes: [substitute],
  };
  return {
    id: PLAN_ID,
    version: 1,
    nutritionist: { firstName: 'Ana', lastName: 'Nutri', avatarUrl: 'avatars/ana.png' },
    guidance: { waterTargetMl: WATER_TARGET_ML, freeMealsPerWeek: 0, freeMealText: null, supplements: [], patientMessage: null },
    meals: [
      {
        id: 'meal-1',
        name: 'Café',
        time: '07:00',
        order: 0,
        tip: null,
        options: [
          { id: 'opt-1', position: 1, items: [item], totals: {} },
          { id: 'opt-2', position: 2, items: [], totals: {} },
        ],
      },
    ],
  };
}

// Test helper: build a mocked prisma client with a published plan.
function makePrisma({ plan = { id: PLAN_ID, publishedSnapshot: makeSnapshot(), firstPublishedAt: LONG_AGO }, waterMl = null } = {}) {
  return {
    dietProtocol: { findFirst: vi.fn().mockResolvedValue(plan) },
    dietMealLog: {
      findMany: vi.fn().mockResolvedValue([]),
      upsert: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    dietSwapLog: {
      findMany: vi.fn().mockResolvedValue([]),
      upsert: vi.fn().mockResolvedValue({}),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    waterLog: { findUnique: vi.fn().mockResolvedValue(waterMl == null ? null : { ml: waterMl }) },
    $queryRaw: vi.fn().mockResolvedValue([{ ml: 0 }]),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

// Test helper: asserts the promise rejects with the day-out-of-range contract.
async function expectDayOutOfRange(promise) {
  await expect(promise).rejects.toMatchObject({
    httpStatus: HTTP_UNPROCESSABLE,
    error: NutritionErrorCode.DAY_OUT_OF_RANGE,
    messageCode: NutritionMessageCode.DAY_OUT_OF_RANGE,
  });
}

// Test helper: raw SQL parameters of the water upsert, in query order.
function waterParams(prisma) {
  return prisma.$queryRaw.mock.calls[0].slice(1);
}

// Test helper: asserts the promise rejects with the plan-not-found contract.
async function expectPlanNotFound(promise) {
  await expect(promise).rejects.toMatchObject({
    httpStatus: HTTP_NOT_FOUND,
    error: NutritionErrorCode.PLAN_NOT_FOUND,
    messageCode: NutritionMessageCode.PLAN_NOT_FOUND,
  });
}

describe('getToday', () => {
  it('should return plan null without a published plan', async () => {
    const prisma = makePrisma({ plan: null });

    const result = await getToday(prisma, { patientId: PATIENT_ID, date: DATE });

    expect(result).toEqual({ date: DATE, plan: null });
  });

  it('should look only at published plans of an active nutritionist link', async () => {
    const prisma = makePrisma();

    await getToday(prisma, { patientId: PATIENT_ID, date: DATE });

    expect(prisma.dietProtocol.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          assigneeId: PATIENT_ID,
          status: 'published',
          nutritionist: { patients: { some: { patientId: PATIENT_ID, deletedAt: null } } },
        },
      }),
    );
  });

  it('should resolve the nutritionist avatar key into a URL', async () => {
    const result = await getToday(makePrisma(), { patientId: PATIENT_ID, date: DATE });

    expect(result.plan.nutritionist.avatarUrl).toBe('https://cdn/avatars/ana.png');
  });

  it('should report the consumed water of the day', async () => {
    const result = await getToday(makePrisma({ waterMl: 500 }), { patientId: PATIENT_ID, date: DATE });

    expect(result.plan.water).toMatchObject({ consumedMl: 500, targetMl: WATER_TARGET_ML });
  });
});

describe('setMealLog', () => {
  let prisma;

  beforeEach(() => {
    prisma = makePrisma();
  });

  it('should upsert the status with doneAt and note when marking a meal done', async () => {
    await setMealLog(prisma, { patientId: PATIENT_ID, date: DATE, mealId: 'meal-1', body: { status: MealLogStatus.DONE } });

    const call = prisma.dietMealLog.upsert.mock.calls[0][0];
    expect(call.where).toEqual({
      patientId_planId_date_mealId: { patientId: PATIENT_ID, planId: PLAN_ID, date: DATE_KEY, mealId: 'meal-1' },
    });
    expect(call.create).toMatchObject({
      patientId: PATIENT_ID,
      planId: PLAN_ID,
      date: DATE_KEY,
      mealId: 'meal-1',
      status: MealLogStatus.DONE,
      note: null,
    });
    expect(call.create.doneAt).toBeInstanceOf(Date);
  });

  it('should store the note when the patient ate differently', async () => {
    const body = { status: MealLogStatus.DIFFERENT, note: 'pizza' };

    await setMealLog(prisma, { patientId: PATIENT_ID, date: DATE, mealId: 'meal-1', body });

    expect(prisma.dietMealLog.upsert.mock.calls[0][0].update).toMatchObject({ status: MealLogStatus.DIFFERENT, note: 'pizza' });
  });

  it('should write only the option when the body carries no status', async () => {
    await setMealLog(prisma, { patientId: PATIENT_ID, date: DATE, mealId: 'meal-1', body: { optionId: 'opt-2' } });

    expect(prisma.dietMealLog.upsert.mock.calls[0][0].update).toEqual({ optionId: 'opt-2' });
  });

  it('should write both option and status when the body carries both', async () => {
    const body = { optionId: 'opt-2', status: MealLogStatus.DONE };

    await setMealLog(prisma, { patientId: PATIENT_ID, date: DATE, mealId: 'meal-1', body });

    expect(prisma.dietMealLog.upsert.mock.calls[0][0].update).toMatchObject({ optionId: 'opt-2', status: MealLogStatus.DONE });
  });

  it('should return the refreshed today view', async () => {
    const result = await setMealLog(prisma, {
      patientId: PATIENT_ID,
      date: DATE,
      mealId: 'meal-1',
      body: { status: MealLogStatus.DONE },
    });

    expect(result.plan.id).toBe(PLAN_ID);
  });

  it('should throw 404 plan not found without a published plan', async () => {
    prisma = makePrisma({ plan: null });

    await expectPlanNotFound(
      setMealLog(prisma, { patientId: PATIENT_ID, date: DATE, mealId: 'meal-1', body: { status: MealLogStatus.DONE } }),
    );
  });

  it('should throw 404 plan not found for a meal outside the snapshot', async () => {
    await expectPlanNotFound(
      setMealLog(prisma, { patientId: PATIENT_ID, date: DATE, mealId: 'meal-x', body: { status: MealLogStatus.DONE } }),
    );
    expect(prisma.dietMealLog.upsert).not.toHaveBeenCalled();
  });

  it('should throw 404 plan not found for an option outside the meal', async () => {
    await expectPlanNotFound(
      setMealLog(prisma, { patientId: PATIENT_ID, date: DATE, mealId: 'meal-1', body: { optionId: 'opt-x' } }),
    );
    expect(prisma.dietMealLog.upsert).not.toHaveBeenCalled();
  });
});

describe('undoMealLog', () => {
  it('should clear status, doneAt and note without touching the option', async () => {
    const prisma = makePrisma();

    await undoMealLog(prisma, { patientId: PATIENT_ID, date: DATE, mealId: 'meal-1' });

    expect(prisma.dietMealLog.updateMany).toHaveBeenCalledWith({
      where: { patientId: PATIENT_ID, planId: PLAN_ID, date: DATE_KEY, mealId: 'meal-1' },
      data: { status: null, doneAt: null, note: null },
    });
  });

  it('should throw 404 plan not found without a published plan', async () => {
    await expectPlanNotFound(undoMealLog(makePrisma({ plan: null }), { patientId: PATIENT_ID, date: DATE, mealId: 'meal-1' }));
  });

  it('should throw 404 plan not found for a meal outside the snapshot', async () => {
    const prisma = makePrisma();

    await expectPlanNotFound(undoMealLog(prisma, { patientId: PATIENT_ID, date: DATE, mealId: 'meal-x' }));
    expect(prisma.dietMealLog.updateMany).not.toHaveBeenCalled();
  });
});

describe('setSwap and undoSwap', () => {
  it('should upsert the swap of a released substitute', async () => {
    const prisma = makePrisma();

    await setSwap(prisma, { patientId: PATIENT_ID, date: DATE, itemId: 'item-1', substituteId: 'sub-1' });

    expect(prisma.dietSwapLog.upsert).toHaveBeenCalledWith({
      where: { patientId_planId_date_itemId: { patientId: PATIENT_ID, planId: PLAN_ID, date: DATE_KEY, itemId: 'item-1' } },
      create: { patientId: PATIENT_ID, planId: PLAN_ID, date: DATE_KEY, itemId: 'item-1', substituteId: 'sub-1' },
      update: { substituteId: 'sub-1' },
    });
  });

  it('should reject a substitute that was not released with 422', async () => {
    const prisma = makePrisma();

    await expect(
      setSwap(prisma, { patientId: PATIENT_ID, date: DATE, itemId: 'item-1', substituteId: 'sub-x' }),
    ).rejects.toMatchObject({ httpStatus: 422, error: NutritionErrorCode.SWAP_NOT_ALLOWED });
    expect(prisma.dietSwapLog.upsert).not.toHaveBeenCalled();
  });

  it('should delete the swap of the item for the date', async () => {
    const prisma = makePrisma();

    await undoSwap(prisma, { patientId: PATIENT_ID, date: DATE, itemId: 'item-1' });

    expect(prisma.dietSwapLog.deleteMany).toHaveBeenCalledWith({
      where: { patientId: PATIENT_ID, planId: PLAN_ID, date: DATE_KEY, itemId: 'item-1' },
    });
  });

  it('should throw 404 plan not found when undoing the swap of an unknown item', async () => {
    await expectPlanNotFound(undoSwap(makePrisma(), { patientId: PATIENT_ID, date: DATE, itemId: 'item-x' }));
  });
});

describe('addWater', () => {
  it('should send the delta and the 2x target ceiling to the atomic upsert', async () => {
    const prisma = makePrisma({ waterMl: 500 });

    await addWater(prisma, { patientId: PATIENT_ID, date: DATE, ml: 250 });

    const maxMl = WATER_TARGET_ML * 2;
    expect(waterParams(prisma)).toEqual([PATIENT_ID, DATE, maxMl, 250, maxMl, 250]);
  });

  it('should pass a negative delta through so the database clamps it at zero', async () => {
    const prisma = makePrisma();

    await addWater(prisma, { patientId: PATIENT_ID, date: DATE, ml: -250 });

    expect(waterParams(prisma).slice(3)).toEqual([-250, WATER_TARGET_ML * 2, -250]);
  });

  it('should use the default target ceiling when the plan has none', async () => {
    const snapshot = makeSnapshot();
    snapshot.guidance.waterTargetMl = null;
    const prisma = makePrisma({ plan: { id: PLAN_ID, publishedSnapshot: snapshot, firstPublishedAt: LONG_AGO } });

    await addWater(prisma, { patientId: PATIENT_ID, date: DATE, ml: 500 });

    expect(waterParams(prisma)[2]).toBe(maxWaterMl(DEFAULT_WATER_TARGET_ML));
  });

  it('should return the refreshed today view', async () => {
    const result = await addWater(makePrisma({ waterMl: 750 }), { patientId: PATIENT_ID, date: DATE, ml: 250 });

    expect(result.plan.water).toMatchObject({ consumedMl: 750 });
  });

  it('should throw 404 plan not found without a published plan', async () => {
    await expectPlanNotFound(addWater(makePrisma({ plan: null }), { patientId: PATIENT_ID, date: DATE, ml: 250 }));
  });

  it('should throw 422 day out of range after tomorrow without writing', async () => {
    const prisma = makePrisma();

    await expectDayOutOfRange(addWater(prisma, { patientId: PATIENT_ID, date: AFTER_TOMORROW, ml: 250 }));
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('should accept tomorrow', async () => {
    const prisma = makePrisma();

    await addWater(prisma, { patientId: PATIENT_ID, date: TOMORROW, ml: 250 });

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });
});

describe('day window of the writes', () => {
  const publishedToday = { id: PLAN_ID, publishedSnapshot: makeSnapshot(), firstPublishedAt: PUBLISHED_TODAY };
  const doneBody = { status: MealLogStatus.DONE };

  it('should reject setMealLog before the first published day', async () => {
    const prisma = makePrisma({ plan: publishedToday });

    await expectDayOutOfRange(setMealLog(prisma, { patientId: PATIENT_ID, date: BEFORE_PUBLICATION, mealId: 'meal-1', body: doneBody }));
    expect(prisma.dietMealLog.upsert).not.toHaveBeenCalled();
  });

  it('should reject setMealLog after tomorrow', async () => {
    const prisma = makePrisma();

    await expectDayOutOfRange(setMealLog(prisma, { patientId: PATIENT_ID, date: AFTER_TOMORROW, mealId: 'meal-1', body: doneBody }));
  });

  it('should accept setMealLog on the first published day', async () => {
    const prisma = makePrisma({ plan: publishedToday });

    await setMealLog(prisma, { patientId: PATIENT_ID, date: DATE, mealId: 'meal-1', body: doneBody });

    expect(prisma.dietMealLog.upsert).toHaveBeenCalledTimes(1);
  });

  it('should reject setSwap before the first published day', async () => {
    const prisma = makePrisma({ plan: publishedToday });

    await expectDayOutOfRange(
      setSwap(prisma, { patientId: PATIENT_ID, date: BEFORE_PUBLICATION, itemId: 'item-1', substituteId: 'sub-1' }),
    );
    expect(prisma.dietSwapLog.upsert).not.toHaveBeenCalled();
  });

  it('should reject setSwap after tomorrow', async () => {
    await expectDayOutOfRange(
      setSwap(makePrisma(), { patientId: PATIENT_ID, date: AFTER_TOMORROW, itemId: 'item-1', substituteId: 'sub-1' }),
    );
  });

  it('should reject addWater before the first published day', async () => {
    const prisma = makePrisma({ plan: publishedToday });

    await expectDayOutOfRange(addWater(prisma, { patientId: PATIENT_ID, date: BEFORE_PUBLICATION, ml: 250 }));
  });

  it('should still allow undoing a meal of a day outside the window', async () => {
    const prisma = makePrisma({ plan: publishedToday });

    await undoMealLog(prisma, { patientId: PATIENT_ID, date: BEFORE_PUBLICATION, mealId: 'meal-1' });

    expect(prisma.dietMealLog.updateMany).toHaveBeenCalledTimes(1);
  });
});
