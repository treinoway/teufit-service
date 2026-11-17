import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  resolveTrainerOwnerOrThrow,
  resolveProfessionalOwnerOrThrow,
} from '../../src/services/professional-owner-service.js';
import {
  OWNER_USER_ID,
  OWNER_TRAINER_ID,
  OWNER_NUTRITIONIST_ID,
  PROFESSIONAL_NOT_FOUND_MESSAGE_CODE,
  TRAINER_NOT_FOUND_MESSAGE_CODE,
} from '../helpers/subscription-owner-fixtures.js';

const NOT_FOUND = 404;

const mockPrisma = {
  trainer: { findUnique: vi.fn(), findFirst: vi.fn() },
  nutritionist: { findUnique: vi.fn(), findFirst: vi.fn() },
};

// Fakes the trainer row lookup (both lookup styles answer the same row).
function stubTrainer(row) {
  mockPrisma.trainer.findUnique.mockResolvedValue(row);
  mockPrisma.trainer.findFirst.mockResolvedValue(row);
}

// Fakes the nutritionist row lookup; a soft-deleted row is invisible to a deletedAt-null filter.
function stubNutritionist(row) {
  mockPrisma.nutritionist.findUnique.mockResolvedValue(row);
  mockPrisma.nutritionist.findFirst.mockResolvedValue(row && row.deletedAt == null ? row : null);
}

beforeEach(() => {
  stubTrainer(null);
  stubNutritionist(null);
});

describe('resolveTrainerOwnerOrThrow', () => {
  it('should return the trainer owner with a null nutritionistId', async () => {
    stubTrainer({ id: OWNER_TRAINER_ID });

    const owner = await resolveTrainerOwnerOrThrow(mockPrisma, OWNER_USER_ID);

    expect(owner).toEqual({ userId: OWNER_USER_ID, trainerId: OWNER_TRAINER_ID, nutritionistId: null });
  });

  it('should ignore the nutritionist row of a dual-role user', async () => {
    stubTrainer({ id: OWNER_TRAINER_ID });
    stubNutritionist({ id: OWNER_NUTRITIONIST_ID, deletedAt: null });

    const owner = await resolveTrainerOwnerOrThrow(mockPrisma, OWNER_USER_ID);

    expect(owner.nutritionistId).toBeNull();
  });

  it('should throw 404 trainer.notFound when the user has no trainer row', async () => {
    stubNutritionist({ id: OWNER_NUTRITIONIST_ID, deletedAt: null });

    await expect(resolveTrainerOwnerOrThrow(mockPrisma, OWNER_USER_ID)).rejects.toMatchObject({
      httpStatus: NOT_FOUND,
      messageCode: TRAINER_NOT_FOUND_MESSAGE_CODE,
      error: expect.any(String),
      message: expect.any(String),
    });
  });
});

describe('resolveProfessionalOwnerOrThrow', () => {
  it('should return only the trainer id for a trainer-only user', async () => {
    stubTrainer({ id: OWNER_TRAINER_ID });

    const owner = await resolveProfessionalOwnerOrThrow(mockPrisma, OWNER_USER_ID);

    expect(owner).toEqual({ userId: OWNER_USER_ID, trainerId: OWNER_TRAINER_ID, nutritionistId: null });
  });

  it('should return only the nutritionist id for a nutritionist-only user', async () => {
    stubNutritionist({ id: OWNER_NUTRITIONIST_ID, deletedAt: null });

    const owner = await resolveProfessionalOwnerOrThrow(mockPrisma, OWNER_USER_ID);

    expect(owner).toEqual({ userId: OWNER_USER_ID, trainerId: null, nutritionistId: OWNER_NUTRITIONIST_ID });
  });

  it('should return both ids for a dual-role user', async () => {
    stubTrainer({ id: OWNER_TRAINER_ID });
    stubNutritionist({ id: OWNER_NUTRITIONIST_ID, deletedAt: null });

    const owner = await resolveProfessionalOwnerOrThrow(mockPrisma, OWNER_USER_ID);

    expect(owner).toEqual({
      userId: OWNER_USER_ID,
      trainerId: OWNER_TRAINER_ID,
      nutritionistId: OWNER_NUTRITIONIST_ID,
    });
  });

  it('should ignore a soft-deleted nutritionist row and keep the trainer row', async () => {
    stubTrainer({ id: OWNER_TRAINER_ID });
    stubNutritionist({ id: OWNER_NUTRITIONIST_ID, deletedAt: new Date('2026-01-01T00:00:00Z') });

    const owner = await resolveProfessionalOwnerOrThrow(mockPrisma, OWNER_USER_ID);

    expect(owner.nutritionistId).toBeNull();
    expect(owner.trainerId).toBe(OWNER_TRAINER_ID);
  });

  it('should throw 404 professional.notFound when the only nutritionist row is soft-deleted', async () => {
    stubNutritionist({ id: OWNER_NUTRITIONIST_ID, deletedAt: new Date('2026-01-01T00:00:00Z') });

    await expect(resolveProfessionalOwnerOrThrow(mockPrisma, OWNER_USER_ID)).rejects.toMatchObject({
      httpStatus: NOT_FOUND,
      messageCode: PROFESSIONAL_NOT_FOUND_MESSAGE_CODE,
    });
  });

  it('should throw 404 professional.notFound with the full error contract when the user has neither row', async () => {
    await expect(resolveProfessionalOwnerOrThrow(mockPrisma, OWNER_USER_ID)).rejects.toMatchObject({
      httpStatus: NOT_FOUND,
      messageCode: PROFESSIONAL_NOT_FOUND_MESSAGE_CODE,
      error: expect.any(String),
      message: expect.any(String),
    });
  });
});
