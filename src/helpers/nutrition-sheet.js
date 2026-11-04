import { formatDateOnly } from './date-helpers.js';
import { round2 } from './nutrition-calc.js';
import { Sex } from '../constants/nutrition.js';

const PERCENT = 100;
const VALID_SEX_VALUES = Object.freeze(Object.values(Sex));

// Converts a Prisma Decimal/number to a number (null stays null).
export function toNumber(value) {
  return value == null ? null : Number(value);
}

// Whole years between a birth date and now (null without a birth date).
export function computeAge(birthDate, now = new Date()) {
  if (!birthDate) return null;
  const birth = new Date(birthDate);
  const hadBirthdayThisYear =
    now.getUTCMonth() > birth.getUTCMonth() ||
    (now.getUTCMonth() === birth.getUTCMonth() && now.getUTCDate() >= birth.getUTCDate());
  return now.getUTCFullYear() - birth.getUTCFullYear() - (hadBirthdayThisYear ? 0 : 1);
}

// Lean mass (kg) from weight and body fat percentage.
function leanMass(weightKg, bodyFatPct) {
  if (weightKg == null || bodyFatPct == null) return null;
  return round2(weightKg * (1 - bodyFatPct / PERCENT));
}

// Measurements stored by the nutritionist for this patient.
function measurementsFromProfile(profile) {
  return {
    sex: profile.sex ?? null,
    weightKg: toNumber(profile.weightKg),
    heightCm: toNumber(profile.heightCm),
    bodyFatPct: toNumber(profile.bodyFatPct),
    assessedAt: formatDateOnly(profile.assessedAt),
  };
}

// Measurements prefilled from the patient's own data when no sheet was saved yet.
function measurementsFromUser(user, healthDetail) {
  return {
    sex: VALID_SEX_VALUES.includes(user.gender) ? user.gender : null,
    weightKg: healthDetail?.weight ?? null,
    heightCm: healthDetail?.height ?? null,
    bodyFatPct: healthDetail?.bodyFat ?? null,
    assessedAt: null,
  };
}

// Builds the Sheet contract object from user, health detail and the saved profile.
export function buildSheet({ user, healthDetail, profile }) {
  const measurements = profile ? measurementsFromProfile(profile) : measurementsFromUser(user, healthDetail);
  return {
    sex: measurements.sex,
    birthDate: formatDateOnly(user.birthDate),
    age: computeAge(user.birthDate),
    weightKg: measurements.weightKg,
    heightCm: measurements.heightCm,
    bodyFatPct: measurements.bodyFatPct,
    leanMassKg: leanMass(measurements.weightKg, measurements.bodyFatPct),
    assessedAt: measurements.assessedAt,
  };
}
