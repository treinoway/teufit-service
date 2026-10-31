import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/db.js', () => ({
  prisma: { studentAnamnesis: { findMany: vi.fn() } },
}));

import { listAnamnesisAssignerTrainerIds } from '../../src/services/anamnesis-service.js';

const STUDENT_ID = 'student-1';
const ANAMNESIS_ID = 'anamnesis-1';

// Builds a mocked prisma client whose studentAnamnesis.findMany resolves to the given rows.
function buildPrisma(rows) {
  return { studentAnamnesis: { findMany: vi.fn().mockResolvedValue(rows) } };
}

describe('listAnamnesisAssignerTrainerIds', () => {
  it('should return the trainer ids of every link', async () => {
    const prismaClient = buildPrisma([{ trainerId: 'trainer-a' }, { trainerId: 'trainer-b' }]);

    const result = await listAnamnesisAssignerTrainerIds(STUDENT_ID, ANAMNESIS_ID, prismaClient);

    expect(result).toEqual(['trainer-a', 'trainer-b']);
  });

  it('should return an empty array when there are no links', async () => {
    const prismaClient = buildPrisma([]);

    const result = await listAnamnesisAssignerTrainerIds(STUDENT_ID, ANAMNESIS_ID, prismaClient);

    expect(result).toEqual([]);
  });

  it('should query by student and anamnesis selecting only trainerId', async () => {
    const prismaClient = buildPrisma([]);

    await listAnamnesisAssignerTrainerIds(STUDENT_ID, ANAMNESIS_ID, prismaClient);

    expect(prismaClient.studentAnamnesis.findMany).toHaveBeenCalledWith({
      where: { studentId: STUDENT_ID, anamnesisId: ANAMNESIS_ID },
      select: { trainerId: true },
    });
  });
});
