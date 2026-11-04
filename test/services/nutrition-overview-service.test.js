import { describe, it, expect, vi } from 'vitest';
import { emptyAdherence } from '../../src/services/nutrition-adherence-service.js';

vi.mock('../../src/services/nutritionist-patient-service.js', () => ({ getPatientRow: vi.fn() }));
vi.mock('../../src/config/s3-bucket-handler.js', () => ({ default: { resolveUrl: vi.fn() } }));

const { getPatientRow } = await import('../../src/services/nutritionist-patient-service.js');
const { default: s3BucketHandler } = await import('../../src/config/s3-bucket-handler.js');
const { getOverview } = await import('../../src/services/nutrition-overview-service.js');

const NUTRITIONIST_ID = 'nutri-1';
const PATIENT_ID = 'patient-1';
const RESOLVED_AVATAR = 'https://cdn.example.com/avatar.png';
const PATIENT_ROW = { id: PATIENT_ID, firstName: 'Ana' };

// Test helper: builds a mocked prisma client returning the given trainer link.
function makePrisma(link = null) {
  return { trainerStudent: { findFirst: vi.fn().mockResolvedValue(link) } };
}

// Test helper: builds a trainer link row.
function makeLink(user) {
  return { trainer: { user } };
}

describe('getOverview', () => {
  it('should return a null trainer when the patient has no trainer link', async () => {
    getPatientRow.mockResolvedValue({ row: PATIENT_ROW, adherence: null });

    const overview = await getOverview(makePrisma(), { nutritionistId: NUTRITIONIST_ID, patientId: PATIENT_ID });

    expect(overview.trainer).toBeNull();
    expect(s3BucketHandler.resolveUrl).not.toHaveBeenCalled();
  });

  it('should map the trainer user and resolve the avatar url', async () => {
    getPatientRow.mockResolvedValue({ row: PATIENT_ROW, adherence: null });
    s3BucketHandler.resolveUrl.mockResolvedValue(RESOLVED_AVATAR);
    const prisma = makePrisma(makeLink({ id: 'trainer-1', firstName: 'Bob', lastName: 'Lee', avatarUrl: 'avatars/bob.png' }));

    const overview = await getOverview(prisma, { nutritionistId: NUTRITIONIST_ID, patientId: PATIENT_ID });

    expect(overview.trainer).toEqual({ id: 'trainer-1', firstName: 'Bob', lastName: 'Lee', avatarUrl: RESOLVED_AVATAR });
    expect(s3BucketHandler.resolveUrl).toHaveBeenCalledWith('avatars/bob.png');
  });

  it('should default missing trainer names to null', async () => {
    getPatientRow.mockResolvedValue({ row: PATIENT_ROW, adherence: null });
    s3BucketHandler.resolveUrl.mockResolvedValue(null);
    const prisma = makePrisma(makeLink({ id: 'trainer-1', firstName: undefined, lastName: undefined, avatarUrl: null }));

    const overview = await getOverview(prisma, { nutritionistId: NUTRITIONIST_ID, patientId: PATIENT_ID });

    expect(overview.trainer).toEqual({ id: 'trainer-1', firstName: null, lastName: null, avatarUrl: null });
  });

  it('should return a null trainer when the link has no user', async () => {
    getPatientRow.mockResolvedValue({ row: PATIENT_ROW, adherence: null });

    const overview = await getOverview(makePrisma(makeLink(null)), { nutritionistId: NUTRITIONIST_ID, patientId: PATIENT_ID });

    expect(overview.trainer).toBeNull();
  });

  it('should return the patient row and the adherence from the patient service', async () => {
    const adherence = { ...emptyAdherence(), mealsDone: 4, mealsExpected: 5, percent: 80 };
    getPatientRow.mockResolvedValue({ row: PATIENT_ROW, adherence });
    const prisma = makePrisma();

    const overview = await getOverview(prisma, { nutritionistId: NUTRITIONIST_ID, patientId: PATIENT_ID });

    expect(overview).toEqual({ patient: PATIENT_ROW, trainer: null, adherence7d: adherence });
    expect(getPatientRow).toHaveBeenCalledWith(prisma, { nutritionistId: NUTRITIONIST_ID, patientId: PATIENT_ID });
  });

  it('should fall back to empty adherence when the patient has none', async () => {
    getPatientRow.mockResolvedValue({ row: PATIENT_ROW, adherence: null });

    const overview = await getOverview(makePrisma(), { nutritionistId: NUTRITIONIST_ID, patientId: PATIENT_ID });

    expect(overview.adherence7d).toEqual(emptyAdherence());
  });

  it('should query the oldest active trainer of the patient', async () => {
    getPatientRow.mockResolvedValue({ row: PATIENT_ROW, adherence: null });
    const prisma = makePrisma();

    await getOverview(prisma, { nutritionistId: NUTRITIONIST_ID, patientId: PATIENT_ID });

    expect(prisma.trainerStudent.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { studentId: PATIENT_ID, trainer: { deletedAt: null } },
        orderBy: [{ activeOnPlan: 'desc' }, { createdAt: 'asc' }],
      }),
    );
  });
});
