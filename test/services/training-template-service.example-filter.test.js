import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db.js', () => ({
  prisma: {
    trainer: { findUnique: vi.fn() },
    trainingTemplate: { findMany: vi.fn(), count: vi.fn() },
  },
}));

import { prisma } from '../../src/db.js';
import { getTrainingTemplatesByTrainer } from '../../src/services/training-template-service.js';

describe('getTrainingTemplatesByTrainer example filter', () => {
  beforeEach(() => {
    prisma.trainer.findUnique.mockResolvedValue({ id: 't1' });
    prisma.trainingTemplate.findMany.mockResolvedValue([]);
    prisma.trainingTemplate.count.mockResolvedValue(0);
  });

  it('should exclude example templates from the list query', async () => {
    await getTrainingTemplatesByTrainer('u1');

    expect(prisma.trainingTemplate.findMany.mock.calls[0][0].where).toMatchObject({ isExample: false });
  });

  it('should exclude example templates from the count query', async () => {
    await getTrainingTemplatesByTrainer('u1');

    expect(prisma.trainingTemplate.count.mock.calls[0][0].where).toMatchObject({ isExample: false });
  });

  it('should keep excluding example templates when other filters are applied', async () => {
    await getTrainingTemplatesByTrainer('u1', { q: 'leg' });

    expect(prisma.trainingTemplate.findMany.mock.calls[0][0].where).toMatchObject({
      isExample: false,
      name: { contains: 'leg', mode: 'insensitive' },
    });
  });
});
