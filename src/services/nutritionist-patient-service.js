import { AppError } from '../errors/app-error.js';
import { DietErrorCode, DietMessageCode, tmbFormulaValues, activityLevelValues } from '../constants/diet.js';
import { calculateTmb, calculateGet } from './tmb-calculator-service.js';
import { formatDateOnly } from '../helpers/date-helpers.js';

function buildDietError(errorCode, messageCode, message, httpStatus = 400) {
  return new AppError({ httpStatus, error: errorCode, messageCode, message });
}

function toNumber(value) {
  return value != null ? Number(value) : null;
}

function normalizeMetabolicProfile(profile) {
  if (!profile) return null;
  return {
    ...profile,
    weightKg: toNumber(profile.weightKg),
    heightCm: toNumber(profile.heightCm),
    leanBodyMassKg: toNumber(profile.leanBodyMassKg),
    tmbKcal: toNumber(profile.tmbKcal),
    palMultiplier: toNumber(profile.palMultiplier),
    getKcal: toNumber(profile.getKcal),
  };
}

function computeAgeFromBirthDate(birthDate) {
  if (!birthDate) return null;
  const today = new Date();
  const birth = new Date(birthDate);
  let age = today.getUTCFullYear() - birth.getUTCFullYear();
  const monthDiff = today.getUTCMonth() - birth.getUTCMonth();
  if (monthDiff < 0 || (monthDiff === 0 && today.getUTCDate() < birth.getUTCDate())) {
    age -= 1;
  }
  return age;
}

/**
 * Link a patient to a nutritionist.
 *
 * @param {object} db - Prisma client
 * @param {string} nutritionistUserId - User ID of the nutritionist
 * @param {string} patientId - User ID of the patient
 * @param {object} data - Optional data (notes)
 * @returns {Promise<object>} Created link
 */
export async function linkPatient(db, nutritionistUserId, email, data = {}) {
  const nutritionist = await db.nutritionist.findUnique({
    where: { userId: nutritionistUserId },
    select: { id: true },
  });

  if (!nutritionist) {
    throw buildDietError(
      DietErrorCode.NUTRITIONIST_NOT_FOUND,
      'nutritionist.notFound',
      'Nutritionist profile not found.',
      404,
    );
  }

  const patient = await db.user.findUnique({
    where: { email },
    select: { id: true, deletedAt: true },
  });

  if (!patient || patient.deletedAt) {
    throw buildDietError(
      DietErrorCode.PATIENT_NOT_FOUND,
      DietMessageCode.PATIENT_NOT_FOUND,
      'Patient not found.',
      404,
    );
  }

  const patientId = patient.id;

  const existing = await db.nutritionistPatient.findUnique({
    where: { nutritionistId_patientId: { nutritionistId: nutritionist.id, patientId } },
  });

  if (existing && !existing.deletedAt) {
    throw buildDietError(
      DietErrorCode.PATIENT_ALREADY_LINKED,
      DietMessageCode.PATIENT_ALREADY_LINKED,
      'Patient is already linked to this nutritionist.',
      409,
    );
  }

  if (existing && existing.deletedAt) {
    return db.nutritionistPatient.update({
      where: { id: existing.id },
      data: {
        status: 'active',
        notes: data.notes !== undefined ? data.notes : existing.notes,
        deletedAt: null,
      },
      include: {
        patient: {
          select: { id: true, firstName: true, lastName: true, email: true, avatarUrl: true },
        },
      },
    });
  }

  return db.nutritionistPatient.create({
    data: {
      nutritionistId: nutritionist.id,
      patientId,
      notes: data.notes || null,
    },
    include: {
      patient: {
        select: { id: true, firstName: true, lastName: true, email: true, avatarUrl: true },
      },
    },
  });
}

/**
 * Unlink (soft-delete) a patient from a nutritionist.
 *
 * @param {object} db - Prisma client
 * @param {string} nutritionistUserId - User ID of the nutritionist
 * @param {string} patientId - User ID of the patient
 * @returns {Promise<object>} Updated link
 */
export async function unlinkPatient(db, nutritionistUserId, patientId) {
  const nutritionist = await db.nutritionist.findUnique({
    where: { userId: nutritionistUserId },
    select: { id: true },
  });

  if (!nutritionist) {
    throw buildDietError(
      DietErrorCode.NUTRITIONIST_NOT_FOUND,
      'nutritionist.notFound',
      'Nutritionist profile not found.',
      404,
    );
  }

  const link = await db.nutritionistPatient.findUnique({
    where: { nutritionistId_patientId: { nutritionistId: nutritionist.id, patientId } },
  });

  if (!link || link.deletedAt) {
    throw buildDietError(
      DietErrorCode.PATIENT_NOT_LINKED,
      DietMessageCode.PATIENT_NOT_LINKED,
      'Patient is not linked to this nutritionist.',
      404,
    );
  }

  return db.nutritionistPatient.update({
    where: { id: link.id },
    data: { deletedAt: new Date(), status: 'inactive' },
  });
}

/**
 * List all active patients for a nutritionist.
 *
 * @param {object} db - Prisma client
 * @param {string} nutritionistUserId - User ID of the nutritionist
 * @returns {Promise<object[]>} List of patient links with patient and metabolic profile
 */
export async function listPatients(db, nutritionistUserId) {
  const nutritionist = await db.nutritionist.findUnique({
    where: { userId: nutritionistUserId },
    select: { id: true },
  });

  if (!nutritionist) {
    throw buildDietError(
      DietErrorCode.NUTRITIONIST_NOT_FOUND,
      'nutritionist.notFound',
      'Nutritionist profile not found.',
      404,
    );
  }

  const links = await db.nutritionistPatient.findMany({
    where: { nutritionistId: nutritionist.id, deletedAt: null },
    include: {
      patient: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          avatarUrl: true,
          birthDate: true,
          gender: true,
          metabolicProfile: true,
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  return links.map((link) => {
    const { metabolicProfile, ...patientFields } = link.patient ?? {};
    return {
      ...link,
      patient: link.patient
        ? { ...patientFields, birthDate: formatDateOnly(patientFields.birthDate) }
        : null,
      metabolicProfile: metabolicProfile ? normalizeMetabolicProfile(metabolicProfile) : null,
    };
  });
}

/**
 * Validate that a patient is linked to a nutritionist (not deleted).
 * Returns the nutritionist record.
 */
async function validatePatientLink(db, nutritionistUserId, patientId) {
  const nutritionist = await db.nutritionist.findUnique({
    where: { userId: nutritionistUserId },
    select: { id: true },
  });

  if (!nutritionist) {
    throw buildDietError(
      DietErrorCode.NUTRITIONIST_NOT_FOUND,
      'nutritionist.notFound',
      'Nutritionist profile not found.',
      404,
    );
  }

  const link = await db.nutritionistPatient.findUnique({
    where: { nutritionistId_patientId: { nutritionistId: nutritionist.id, patientId } },
  });

  if (!link || link.deletedAt) {
    throw buildDietError(
      DietErrorCode.PATIENT_NOT_LINKED,
      DietMessageCode.PATIENT_NOT_LINKED,
      'Patient is not linked to this nutritionist.',
      404,
    );
  }

  return nutritionist;
}

/**
 * Create or update the metabolic profile of a patient.
 * Calculates TMB and GET when formula and activity level are provided.
 *
 * @param {object} db - Prisma client
 * @param {string} nutritionistUserId - User ID of the nutritionist
 * @param {string} patientId - User ID of the patient
 * @param {object} data - Profile data
 * @returns {Promise<object>} Upserted metabolic profile
 */
export async function upsertMetabolicProfile(db, nutritionistUserId, patientId, data) {
  const nutritionist = await validatePatientLink(db, nutritionistUserId, patientId);

  if (data.tmbFormula && !tmbFormulaValues.includes(data.tmbFormula)) {
    throw new AppError({
      httpStatus: 400,
      error: 'INVALID_TMB_FORMULA',
      messageCode: 'validation.failed',
      message: `Invalid TMB formula: ${data.tmbFormula}.`,
    });
  }

  if (data.activityLevel && !activityLevelValues.includes(data.activityLevel)) {
    throw new AppError({
      httpStatus: 400,
      error: 'INVALID_ACTIVITY_LEVEL',
      messageCode: 'validation.failed',
      message: `Invalid activity level: ${data.activityLevel}.`,
    });
  }

  let tmbKcal = data.tmbKcal ?? undefined;
  let getKcal = data.getKcal ?? undefined;
  let palMultiplier = data.palMultiplier ?? undefined;

  const shouldCalculateTmb = data.tmbFormula && (data.weightKg || data.heightCm);

  if (shouldCalculateTmb) {
    const patient = await db.user.findUnique({
      where: { id: patientId },
      select: { birthDate: true, gender: true },
    });

    const ageYears = computeAgeFromBirthDate(patient?.birthDate);
    const gender = patient?.gender || null;

    const tmbParams = {
      weightKg: data.weightKg ? Number(data.weightKg) : undefined,
      heightCm: data.heightCm ? Number(data.heightCm) : undefined,
      leanBodyMassKg: data.leanBodyMassKg ? Number(data.leanBodyMassKg) : undefined,
      ageYears,
      gender,
    };

    tmbKcal = calculateTmb(data.tmbFormula, tmbParams);

    if (data.activityLevel) {
      const getResult = calculateGet(tmbKcal, data.activityLevel);
      getKcal = getResult.getKcal;
      palMultiplier = getResult.palMultiplier;
    }
  } else if (data.tmbKcal != null && data.activityLevel) {
    const getResult = calculateGet(Number(data.tmbKcal), data.activityLevel);
    getKcal = getResult.getKcal;
    palMultiplier = getResult.palMultiplier;
  }

  const profileData = {
    nutritionistId: nutritionist.id,
    ...(data.weightKg !== undefined && { weightKg: data.weightKg }),
    ...(data.heightCm !== undefined && { heightCm: data.heightCm }),
    ...(data.leanBodyMassKg !== undefined && { leanBodyMassKg: data.leanBodyMassKg }),
    ...(data.tmbFormula !== undefined && { tmbFormula: data.tmbFormula }),
    ...(tmbKcal !== undefined && { tmbKcal }),
    ...(data.activityLevel !== undefined && { activityLevel: data.activityLevel }),
    ...(palMultiplier !== undefined && { palMultiplier }),
    ...(getKcal !== undefined && { getKcal }),
  };

  const result = await db.patientMetabolicProfile.upsert({
    where: { patientId },
    create: { patientId, ...profileData },
    update: profileData,
  });
  return normalizeMetabolicProfile(result);
}
