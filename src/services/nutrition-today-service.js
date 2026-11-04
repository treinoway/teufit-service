import s3BucketHandler from '../config/s3-bucket-handler.js';
import {
  buildToday,
  maxWaterMl,
  assertSwapAllowed,
  requireSnapshotMeal,
  assertOptionInMeal,
  findSnapshotItem,
  planNotFoundError,
  assertDayWritable,
} from '../helpers/nutrition-today.js';
import { todayInBusinessTz, formatDateOnly } from '../helpers/date-helpers.js';
import { DEFAULT_WATER_TARGET_ML, PlanStatus } from '../constants/nutrition.js';

// Midnight-UTC Date for a YYYY-MM-DD string (the @db.Date key).
function toDateKey(date) {
  return new Date(`${date}T00:00:00.000Z`);
}

// Today's date (YYYY-MM-DD) in the business timezone.
function currentDate() {
  return formatDateOnly(todayInBusinessTz());
}

// Latest published plan of a patient whose nutritionist link is active; null if none.
function findPublishedPlan(prisma, patientId) {
  return prisma.dietProtocol.findFirst({
    where: {
      assigneeId: patientId,
      status: PlanStatus.PUBLISHED,
      nutritionist: { patients: { some: { patientId, deletedAt: null } } },
    },
    orderBy: { publishedAt: 'desc' },
    select: { id: true, publishedSnapshot: true, firstPublishedAt: true },
  });
}

// Like findPublishedPlan but throws 404 when the patient has none.
async function requirePublishedPlan(prisma, patientId) {
  const plan = await findPublishedPlan(prisma, patientId);
  if (!plan) throw planNotFoundError();
  return plan;
}

// Like requirePublishedPlan, and 422 unless the date can still be written (first published day to tomorrow).
async function requireWritablePlan(prisma, { patientId, date }) {
  const plan = await requirePublishedPlan(prisma, patientId);
  assertDayWritable(date, { firstPublishedAt: plan.firstPublishedAt });
  return plan;
}

// Resolves the nutritionist avatar key into a URL inside the snapshot copy.
async function withResolvedAvatar(snapshot) {
  const avatarUrl = await s3BucketHandler.resolveUrl(snapshot.nutritionist.avatarUrl);
  return { ...snapshot, nutritionist: { ...snapshot.nutritionist, avatarUrl } };
}

// Builds the Today view of a date for a published plan.
async function buildTodayView(prisma, { patientId, plan, date }) {
  const dateKey = toDateKey(date);
  const [mealLogs, swapLogs, waterLog, snapshot] = await Promise.all([
    prisma.dietMealLog.findMany({ where: { patientId, planId: plan.id, date: dateKey } }),
    prisma.dietSwapLog.findMany({ where: { patientId, planId: plan.id, date: dateKey } }),
    prisma.waterLog.findUnique({ where: { patientId_date: { patientId, date: dateKey } } }),
    withResolvedAvatar(plan.publishedSnapshot),
  ]);
  return buildToday({ date, snapshot, mealLogs, swapLogs, waterMl: waterLog?.ml ?? 0 });
}

/**
 * The patient's day: published plan with the logs of the date (plan null without a published plan).
 */
export async function getToday(prisma, { patientId, date = currentDate() }) {
  const plan = await findPublishedPlan(prisma, patientId);
  if (!plan) return { date, plan: null };
  return buildTodayView(prisma, { patientId, plan, date });
}

// Unique key of a meal log.
function mealLogKey({ patientId, planId, date, mealId }) {
  return { patientId_planId_date_mealId: { patientId, planId, date: toDateKey(date), mealId } };
}

// Meal log columns written by a PUT (only what the body carries).
function mealLogChanges({ status, optionId, note }) {
  return {
    ...(optionId !== undefined && { optionId }),
    ...(status !== undefined && { status, doneAt: new Date(), note: note ?? null }),
  };
}

/**
 * Marks a meal done / "ate differently" and/or selects its option for the date.
 */
export async function setMealLog(prisma, { patientId, date, mealId, body }) {
  const plan = await requireWritablePlan(prisma, { patientId, date });
  const meal = requireSnapshotMeal(plan.publishedSnapshot, mealId);
  if (body.optionId !== undefined) assertOptionInMeal(meal, body.optionId);

  const changes = mealLogChanges(body);
  await prisma.dietMealLog.upsert({
    where: mealLogKey({ patientId, planId: plan.id, date, mealId }),
    create: { patientId, planId: plan.id, date: toDateKey(date), mealId, ...changes },
    update: changes,
  });
  return buildTodayView(prisma, { patientId, plan, date });
}

/**
 * Undoes the done / different status of a meal for the date (keeps the option choice).
 */
export async function undoMealLog(prisma, { patientId, date, mealId }) {
  const plan = await requirePublishedPlan(prisma, patientId);
  requireSnapshotMeal(plan.publishedSnapshot, mealId);
  await prisma.dietMealLog.updateMany({
    where: { patientId, planId: plan.id, date: toDateKey(date), mealId },
    data: { status: null, doneAt: null, note: null },
  });
  return buildTodayView(prisma, { patientId, plan, date });
}

/**
 * Applies a released substitute to an item for the date only.
 */
export async function setSwap(prisma, { patientId, date, itemId, substituteId }) {
  const plan = await requireWritablePlan(prisma, { patientId, date });
  assertSwapAllowed(plan.publishedSnapshot, itemId, substituteId);
  await prisma.dietSwapLog.upsert({
    where: { patientId_planId_date_itemId: { patientId, planId: plan.id, date: toDateKey(date), itemId } },
    create: { patientId, planId: plan.id, date: toDateKey(date), itemId, substituteId },
    update: { substituteId },
  });
  return buildTodayView(prisma, { patientId, plan, date });
}

/**
 * Removes the swap of an item for the date.
 */
export async function undoSwap(prisma, { patientId, date, itemId }) {
  const plan = await requirePublishedPlan(prisma, patientId);
  if (!findSnapshotItem(plan.publishedSnapshot, itemId)) throw planNotFoundError();
  await prisma.dietSwapLog.deleteMany({ where: { patientId, planId: plan.id, date: toDateKey(date), itemId } });
  return buildTodayView(prisma, { patientId, plan, date });
}

// Atomically adds the delta to the day water total, clamped to [0, maxMl] (no lost update on concurrent taps).
async function applyWaterDelta(prisma, { patientId, date, deltaMl, maxMl }) {
  await prisma.$queryRaw`
    INSERT INTO water_logs (id, patient_id, date, ml, updated_at)
    VALUES (gen_random_uuid(), ${patientId}::uuid, ${date}::date, LEAST(${maxMl}::int, GREATEST(0, ${deltaMl}::int)), now())
    ON CONFLICT (patient_id, date) DO UPDATE
      SET ml = LEAST(${maxMl}::int, GREATEST(0, water_logs.ml + ${deltaMl}::int)), updated_at = now()
    RETURNING ml`;
}

/**
 * Adds (or, when negative, removes) water for the date, clamped to [0, 2x target].
 */
export async function addWater(prisma, { patientId, date, ml }) {
  const plan = await requireWritablePlan(prisma, { patientId, date });
  const target = plan.publishedSnapshot.guidance.waterTargetMl ?? DEFAULT_WATER_TARGET_ML;
  await applyWaterDelta(prisma, { patientId, date, deltaMl: ml, maxMl: maxWaterMl(target) });
  return buildTodayView(prisma, { patientId, plan, date });
}
