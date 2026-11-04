import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AppError } from '../../src/errors/app-error.js';
import { NutritionErrorCode, NutritionMessageCode } from '../../src/constants/nutrition.js';

vi.mock('../../src/services/nutritionist-patient-service.js', () => ({ requirePatientLink: vi.fn() }));

const { requirePatientLink } = await import('../../src/services/nutritionist-patient-service.js');
const { getSheet, upsertSheet } = await import('../../src/services/nutrition-sheet-service.js');

const NUTRITIONIST_ID = 'nutri-1';
const PATIENT_ID = 'patient-1';
const NOT_FOUND = 404;
const WEIGHT_KG = 80;
const HEIGHT_CM = 180;
const BODY_FAT_PCT = 20;
const LEAN_MASS_KG = 64;
const ASSESSED_AT = '2026-03-10';
const PROFILE_KEY = { patientId_nutritionistId: { patientId: PATIENT_ID, nutritionistId: NUTRITIONIST_ID } };

// Test helper: builds a mocked prisma client.
function makePrisma({ user, profile = null } = {}) {
  return {
    user: {
      findUnique: vi.fn().mockResolvedValue(
        user ?? { birthDate: null, gender: 'male', healthDetail: { weight: 70, height: 175, bodyFat: null } },
      ),
    },
    patientMetabolicProfile: {
      findUnique: vi.fn().mockResolvedValue(profile),
      upsert: vi.fn().mockResolvedValue({}),
    },
  };
}

// Test helper: builds the not-found error thrown by the patient link check.
function makeNotFound() {
  return new AppError({
    httpStatus: NOT_FOUND,
    error: NutritionErrorCode.PATIENT_NOT_FOUND,
    messageCode: NutritionMessageCode.PATIENT_NOT_FOUND,
    message: 'Patient not found.',
  });
}

describe('nutrition-sheet-service', () => {
  beforeEach(() => {
    requirePatientLink.mockResolvedValue(undefined);
  });

  describe('getSheet', () => {
    it('should prefill from the patient health detail when no sheet was saved', async () => {
      const prisma = makePrisma();

      const sheet = await getSheet(prisma, { nutritionistId: NUTRITIONIST_ID, patientId: PATIENT_ID });

      expect(sheet).toMatchObject({ sex: 'male', weightKg: 70, heightCm: 175, bodyFatPct: null, assessedAt: null });
      expect(requirePatientLink).toHaveBeenCalledWith(prisma, { nutritionistId: NUTRITIONIST_ID, patientId: PATIENT_ID });
    });

    it('should return the saved profile instead of the prefill', async () => {
      const profile = {
        sex: 'female',
        weightKg: String(WEIGHT_KG),
        heightCm: String(HEIGHT_CM),
        bodyFatPct: String(BODY_FAT_PCT),
        assessedAt: new Date(`${ASSESSED_AT}T00:00:00.000Z`),
      };
      const prisma = makePrisma({ profile });

      const sheet = await getSheet(prisma, { nutritionistId: NUTRITIONIST_ID, patientId: PATIENT_ID });

      expect(sheet).toMatchObject({
        sex: 'female',
        weightKg: WEIGHT_KG,
        heightCm: HEIGHT_CM,
        bodyFatPct: BODY_FAT_PCT,
        leanMassKg: LEAN_MASS_KG,
        assessedAt: ASSESSED_AT,
      });
    });

    it('should look up the profile by patient and nutritionist', async () => {
      const prisma = makePrisma();

      await getSheet(prisma, { nutritionistId: NUTRITIONIST_ID, patientId: PATIENT_ID });

      expect(prisma.patientMetabolicProfile.findUnique).toHaveBeenCalledWith({ where: PROFILE_KEY });
    });

    it('should propagate the 404 when the patient is not linked', async () => {
      const prisma = makePrisma();
      requirePatientLink.mockRejectedValue(makeNotFound());

      const promise = getSheet(prisma, { nutritionistId: NUTRITIONIST_ID, patientId: PATIENT_ID });

      await expect(promise).rejects.toMatchObject({
        httpStatus: NOT_FOUND,
        error: NutritionErrorCode.PATIENT_NOT_FOUND,
        messageCode: NutritionMessageCode.PATIENT_NOT_FOUND,
      });
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('upsertSheet', () => {
    it('should upsert the profile with all provided fields', async () => {
      const prisma = makePrisma();
      const data = { sex: 'female', weightKg: WEIGHT_KG, heightCm: HEIGHT_CM, bodyFatPct: BODY_FAT_PCT, assessedAt: ASSESSED_AT };

      await upsertSheet(prisma, { nutritionistId: NUTRITIONIST_ID, patientId: PATIENT_ID, data });

      const expectedData = { ...data, assessedAt: new Date(`${ASSESSED_AT}T12:00:00.000Z`) };
      expect(prisma.patientMetabolicProfile.upsert).toHaveBeenCalledWith({
        where: PROFILE_KEY,
        create: { patientId: PATIENT_ID, nutritionistId: NUTRITIONIST_ID, ...expectedData },
        update: expectedData,
      });
    });

    it('should store null for omitted bodyFatPct and assessedAt', async () => {
      const prisma = makePrisma();
      const data = { sex: 'male', weightKg: WEIGHT_KG, heightCm: HEIGHT_CM };

      await upsertSheet(prisma, { nutritionistId: NUTRITIONIST_ID, patientId: PATIENT_ID, data });

      const call = prisma.patientMetabolicProfile.upsert.mock.calls[0][0];
      expect(call.update).toEqual({ ...data, bodyFatPct: null, assessedAt: null });
    });

    it('should return the sheet rebuilt after the save', async () => {
      const profile = { sex: 'male', weightKg: WEIGHT_KG, heightCm: HEIGHT_CM, bodyFatPct: null, assessedAt: null };
      const prisma = makePrisma({ profile });

      const sheet = await upsertSheet(prisma, {
        nutritionistId: NUTRITIONIST_ID,
        patientId: PATIENT_ID,
        data: { sex: 'male', weightKg: WEIGHT_KG, heightCm: HEIGHT_CM },
      });

      expect(sheet).toMatchObject({ sex: 'male', weightKg: WEIGHT_KG, heightCm: HEIGHT_CM, leanMassKg: null });
    });

    it('should propagate the 404 without writing when the patient is not linked', async () => {
      const prisma = makePrisma();
      requirePatientLink.mockRejectedValue(makeNotFound());

      const promise = upsertSheet(prisma, {
        nutritionistId: NUTRITIONIST_ID,
        patientId: PATIENT_ID,
        data: { sex: 'male', weightKg: WEIGHT_KG, heightCm: HEIGHT_CM },
      });

      await expect(promise).rejects.toMatchObject({ httpStatus: NOT_FOUND, error: NutritionErrorCode.PATIENT_NOT_FOUND });
      expect(prisma.patientMetabolicProfile.upsert).not.toHaveBeenCalled();
    });
  });
});
