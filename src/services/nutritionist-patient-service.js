import s3BucketHandler from '../config/s3-bucket-handler.js';
import { NotFoundAppError } from '../errors/app-error.js';
import { computeAge, toNumber } from '../helpers/nutrition-sheet.js';
import { hasPendingChanges } from '../helpers/nutrition-plan-view.js';
import { loadAdherenceByPatient } from './nutrition-adherence-service.js';
import { PlanStatus, PatientLinkStatus, NutritionErrorCode, NutritionMessageCode } from '../constants/nutrition.js';

// Builds the patient-not-found error.
function patientNotFoundError() {
  return new NotFoundAppError({
    error: NutritionErrorCode.PATIENT_NOT_FOUND,
    messageCode: NutritionMessageCode.PATIENT_NOT_FOUND,
    message: 'Patient not found.',
  });
}

/**
 * Active nutritionist-patient link or 404 nutrition.patient.notFound.
 */
export async function requirePatientLink(prisma, { nutritionistId, patientId }) {
  const link = await prisma.nutritionistPatient.findUnique({
    where: { nutritionistId_patientId: { nutritionistId, patientId } },
  });
  if (!link || link.deletedAt) throw patientNotFoundError();
  return link;
}

// Plan summary shown in the patient row.
function toPlanSummary(plan) {
  if (!plan) return null;
  return {
    id: plan.id,
    status: plan.status,
    publishedAt: plan.publishedAt ? plan.publishedAt.toISOString() : null,
    hasUnpublishedChanges: hasPendingChanges(plan),
  };
}

// Adherence summary shown in the patient row.
function toRowAdherence(adherence) {
  if (!adherence) return null;
  return { done: adherence.mealsDone, expected: adherence.mealsExpected, percent: adherence.percent };
}

// Groups rows by a key into a Map (last row wins).
function indexBy(rows, key) {
  return new Map(rows.map((row) => [row[key], row]));
}

// Loads everything needed to render patient rows in 3 queries.
async function loadRowSources(prisma, { nutritionistId, patientIds }) {
  return Promise.all([
    prisma.user.findMany({
      where: { id: { in: patientIds } },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        avatarUrl: true,
        birthDate: true,
        healthDetail: { select: { weight: true } },
      },
    }),
    prisma.dietProtocol.findMany({
      where: { nutritionistId, assigneeId: { in: patientIds } },
      select: {
        id: true,
        assigneeId: true,
        status: true,
        objective: true,
        publishedAt: true,
        firstPublishedAt: true,
        publishedSnapshot: true,
        hasUnpublishedChanges: true,
      },
    }),
    prisma.patientMetabolicProfile.findMany({
      where: { nutritionistId, patientId: { in: patientIds } },
      select: { patientId: true, weightKg: true },
    }),
  ]);
}

// Assembles one PatientRow.
async function toPatientRow({ link, user, plan, profile, adherence }) {
  return {
    id: user.id,
    firstName: user.firstName ?? null,
    lastName: user.lastName ?? null,
    email: user.email,
    avatarUrl: await s3BucketHandler.resolveUrl(user.avatarUrl),
    age: computeAge(user.birthDate),
    weightKg: toNumber(profile?.weightKg) ?? user.healthDetail?.weight ?? null,
    objective: plan ? plan.objective : null,
    plan: toPlanSummary(plan),
    adherence7d: plan?.status === PlanStatus.PUBLISHED ? toRowAdherence(adherence) : null,
    linkedAt: link.createdAt.toISOString(),
  };
}

/**
 * Builds PatientRow objects for links.
 *
 * @returns {Promise<{ rows: object[], adherenceByPatient: Map<string, object> }>}
 */
export async function buildPatientRows(prisma, { nutritionistId, links }) {
  if (links.length === 0) return { rows: [], adherenceByPatient: new Map() };
  const patientIds = links.map((link) => link.patientId);
  const [users, plans, profiles] = await loadRowSources(prisma, { nutritionistId, patientIds });
  const adherenceByPatient = await loadAdherenceByPatient(prisma, plans);
  const userById = indexBy(users, 'id');
  const planByPatient = indexBy(plans, 'assigneeId');
  const profileByPatient = indexBy(profiles, 'patientId');

  const rows = await Promise.all(
    links
      .filter((link) => userById.has(link.patientId))
      .map((link) =>
        toPatientRow({
          link,
          user: userById.get(link.patientId),
          plan: planByPatient.get(link.patientId),
          profile: profileByPatient.get(link.patientId),
          adherence: adherenceByPatient.get(link.patientId),
        }),
      ),
  );
  return { rows, adherenceByPatient };
}

/**
 * Lists the active patients of a nutritionist as PatientRow[].
 */
export async function listPatients(prisma, { nutritionistId }) {
  const links = await prisma.nutritionistPatient.findMany({
    where: { nutritionistId, deletedAt: null, patient: { deletedAt: null } },
    orderBy: { createdAt: 'desc' },
  });
  const { rows } = await buildPatientRows(prisma, { nutritionistId, links });
  return rows;
}

/**
 * One PatientRow (and its adherence) for a linked patient.
 */
export async function getPatientRow(prisma, { nutritionistId, patientId }) {
  const link = await requirePatientLink(prisma, { nutritionistId, patientId });
  const { rows, adherenceByPatient } = await buildPatientRows(prisma, { nutritionistId, links: [link] });
  return { row: rows[0], adherence: adherenceByPatient.get(patientId) ?? null };
}

/**
 * Soft-unlinks a patient from the nutritionist.
 */
export async function unlinkPatient(prisma, { nutritionistId, patientId }) {
  const link = await requirePatientLink(prisma, { nutritionistId, patientId });
  await prisma.nutritionistPatient.update({
    where: { id: link.id },
    data: { deletedAt: new Date(), status: PatientLinkStatus.INACTIVE },
  });
}
