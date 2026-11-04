import { assertPublishable } from '../helpers/nutrition-plan-rules.js';
import { buildSnapshot } from '../helpers/nutrition-plan-view.js';
import { lockDietProtocolForUpdate } from '../helpers/row-locks.js';
import { requirePatientLink } from './nutritionist-patient-service.js';
import { loadPlanView, requireOwnedPlan } from './nutrition-plan-access.js';
import { suggestActivitiesFromTraining } from './nutrition-training-activities-service.js';
import { PlanStatus } from '../constants/nutrition.js';

const UNIQUE_VIOLATION_CODE = 'P2002';

// Initial goals activities: the training suggestion, included and flagged as from training.
async function initialActivities(prisma, patientId) {
  const { items } = await suggestActivitiesFromTraining(prisma, { patientId });
  return items.map((item) => ({ ...item, included: true, fromTraining: true }));
}

// Finds the plan of the pair or creates the draft (race-safe on the unique pair).
async function findOrCreatePlanId(prisma, { nutritionistId, patientId }) {
  const where = { nutritionistId_assigneeId: { nutritionistId, assigneeId: patientId } };
  const existing = await prisma.dietProtocol.findUnique({ where, select: { id: true } });
  if (existing) return existing.id;
  try {
    const activities = await initialActivities(prisma, patientId);
    const created = await prisma.dietProtocol.create({ data: { nutritionistId, assigneeId: patientId, activities }, select: { id: true } });
    return created.id;
  } catch (error) {
    if (error?.code !== UNIQUE_VIOLATION_CODE) throw error;
    return (await prisma.dietProtocol.findUnique({ where, select: { id: true } })).id;
  }
}

/**
 * Plan of a linked patient; creates the draft on the first call.
 */
export async function getOrCreatePlan(prisma, { nutritionistId, patientId }) {
  await requirePatientLink(prisma, { nutritionistId, patientId });
  const planId = await findOrCreatePlanId(prisma, { nutritionistId, patientId });
  return loadPlanView(prisma, { nutritionistId, planId });
}

// Drops undefined entries so a PATCH only touches the sent fields.
function definedFields(data) {
  return Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined));
}

// Applies a partial update to the plan row and returns the Plan.
async function updatePlanFields(prisma, { nutritionistId, planId, data }) {
  await requireOwnedPlan(prisma, { nutritionistId, planId });
  await prisma.dietProtocol.update({
    where: { id: planId },
    data: { ...definedFields(data), hasUnpublishedChanges: true },
  });
  return loadPlanView(prisma, { nutritionistId, planId });
}

// Updates the goals of a plan (partial) and returns the Plan.
export function updateGoals(prisma, args) {
  return updatePlanFields(prisma, args);
}

// Updates the guidance of a plan (partial) and returns the Plan.
export function updateGuidance(prisma, args) {
  return updatePlanFields(prisma, args);
}

// Nutritionist display data stored in the snapshot.
function findNutritionistUser(prisma, nutritionistId) {
  return prisma.nutritionist
    .findUnique({ where: { id: nutritionistId }, select: { user: { select: { firstName: true, lastName: true, avatarUrl: true } } } })
    .then((nutritionist) => nutritionist.user);
}

// Validates and freezes the snapshot under the plan row lock (no lost concurrent edit, no duplicated version).
async function writeSnapshot(tx, { nutritionistId, planId, nutritionistUser }) {
  await lockDietProtocolForUpdate(tx, planId);
  const plan = await requireOwnedPlan(tx, { nutritionistId, planId });
  const view = await loadPlanView(tx, { nutritionistId, planId });
  assertPublishable(view);

  const now = new Date();
  const nextVersion = plan.version + 1;
  await tx.dietProtocol.update({
    where: { id: planId },
    data: {
      status: PlanStatus.PUBLISHED,
      version: nextVersion,
      publishedAt: now,
      firstPublishedAt: plan.firstPublishedAt ?? now,
      publishedSnapshot: buildSnapshot({ ...view, version: nextVersion }, nutritionistUser),
      hasUnpublishedChanges: false,
    },
  });
}

/**
 * Publishes the plan: validates, freezes the snapshot the app reads and bumps the version.
 */
export async function publishPlan(prisma, { nutritionistId, planId }) {
  await requireOwnedPlan(prisma, { nutritionistId, planId });
  const nutritionistUser = await findNutritionistUser(prisma, nutritionistId);
  await prisma.$transaction((tx) => writeSnapshot(tx, { nutritionistId, planId, nutritionistUser }));
  return loadPlanView(prisma, { nutritionistId, planId });
}
