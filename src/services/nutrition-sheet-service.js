import { buildSheet } from '../helpers/nutrition-sheet.js';
import { parseDateOnlyAsUtc } from '../helpers/date-helpers.js';
import { requirePatientLink } from './nutritionist-patient-service.js';

// Loads the patient's user data, health detail and the sheet saved by this nutritionist.
async function loadSheetSources(prisma, { nutritionistId, patientId }) {
  const [user, profile] = await Promise.all([
    prisma.user.findUnique({
      where: { id: patientId },
      select: { birthDate: true, gender: true, healthDetail: true },
    }),
    prisma.patientMetabolicProfile.findUnique({
      where: { patientId_nutritionistId: { patientId, nutritionistId } },
    }),
  ]);
  return { user, healthDetail: user.healthDetail, profile };
}

/**
 * Patient sheet (ficha): the saved sheet or a prefill from the patient's own data.
 */
export async function getSheet(prisma, { nutritionistId, patientId }) {
  await requirePatientLink(prisma, { nutritionistId, patientId });
  return buildSheet(await loadSheetSources(prisma, { nutritionistId, patientId }));
}

// Maps the PUT body to the profile columns (omitted optional fields reset to null).
function toProfileData({ sex, weightKg, heightCm, bodyFatPct, assessedAt }) {
  return {
    sex,
    weightKg,
    heightCm,
    bodyFatPct: bodyFatPct ?? null,
    assessedAt: assessedAt ? parseDateOnlyAsUtc(assessedAt) : null,
  };
}

/**
 * Saves the patient sheet and returns it in the Sheet contract shape.
 */
export async function upsertSheet(prisma, { nutritionistId, patientId, data }) {
  await requirePatientLink(prisma, { nutritionistId, patientId });
  const profileData = toProfileData(data);
  await prisma.patientMetabolicProfile.upsert({
    where: { patientId_nutritionistId: { patientId, nutritionistId } },
    create: { patientId, nutritionistId, ...profileData },
    update: profileData,
  });
  return buildSheet(await loadSheetSources(prisma, { nutritionistId, patientId }));
}
