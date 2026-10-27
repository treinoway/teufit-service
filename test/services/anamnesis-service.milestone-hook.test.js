import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/services/platform-plan-service.js', () => ({
  assertStudentActiveOnPlan: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/services/trainer-onboarding-service.js', () => ({
  maybeMarkFirstAnamnesisSent: vi.fn(),
}));

vi.mock('../../src/db.js', () => ({
  prisma: {
    trainer: { findUnique: vi.fn() },
    anamnesis: { findUnique: vi.fn() },
    studentAnamnesis: { create: vi.fn() },
    trainerStudent: { findUnique: vi.fn() },
  },
}));

import { prisma } from '../../src/db.js';
import { maybeMarkFirstAnamnesisSent } from '../../src/services/trainer-onboarding-service.js';
import { linkAnamnesisToStudent } from '../../src/services/anamnesis-service.js';

const USER_ID = 'user-1';
const TRAINER_ID = 'trainer-1';
const STUDENT_ID = 'student-1';
const ANAMNESIS_ID = 'anamnesis-1';

describe('linkAnamnesisToStudent first-anamnesis-sent milestone hook', () => {
  const link = {
    id: 'link-1',
    anamnesisId: ANAMNESIS_ID,
    studentId: STUDENT_ID,
    trainerId: TRAINER_ID,
    anamnesis: { id: ANAMNESIS_ID, title: 'Health', isGeneral: false },
  };

  beforeEach(() => {
    prisma.trainer.findUnique.mockResolvedValue({ id: TRAINER_ID, userId: USER_ID });
    prisma.trainerStudent.findUnique.mockResolvedValue({ trainerId: TRAINER_ID, studentId: STUDENT_ID });
    prisma.anamnesis.findUnique.mockResolvedValue({ id: ANAMNESIS_ID, trainerId: TRAINER_ID, isGeneral: false, deletedAt: null });
    prisma.studentAnamnesis.create.mockResolvedValue(link);
    maybeMarkFirstAnamnesisSent.mockResolvedValue(undefined);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('should return the created link when the milestone hook rejects', async () => {
    maybeMarkFirstAnamnesisSent.mockRejectedValue(new Error('milestone failed'));

    await expect(linkAnamnesisToStudent(USER_ID, STUDENT_ID, { anamnesisId: ANAMNESIS_ID })).resolves.toBe(link);
  });

  it('should not turn a hook failure into a 409 already-linked error', async () => {
    maybeMarkFirstAnamnesisSent.mockRejectedValue(Object.assign(new Error('dup'), { code: 'P2002' }));

    await expect(linkAnamnesisToStudent(USER_ID, STUDENT_ID, { anamnesisId: ANAMNESIS_ID })).resolves.toBe(link);
  });

  it('should log the milestone failure as non-critical', async () => {
    maybeMarkFirstAnamnesisSent.mockRejectedValue(new Error('milestone failed'));

    await linkAnamnesisToStudent(USER_ID, STUDENT_ID, { anamnesisId: ANAMNESIS_ID });

    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('milestone failed'));
  });
});
