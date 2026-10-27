import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db.js', () => ({
  prisma: {
    trainer: { findUnique: vi.fn() },
    exerciseTemplate: { findMany: vi.fn(), findUnique: vi.fn(), count: vi.fn() },
    trainingTemplate: { findMany: vi.fn(), findUnique: vi.fn(), count: vi.fn() },
  },
}));

import { prisma } from '../../src/db.js';
import {
  getExerciseTemplatesByTrainer,
  getExerciseTemplateById,
  getPublicExerciseTemplates,
} from '../../src/services/exercise-template-service.js';
import {
  getTrainingTemplatesByTrainer,
  getTrainingTemplateById,
  getPublicTrainingTemplates,
} from '../../src/services/training-template-service.js';

const VIEWER_ID = 'trainer-viewer';
const OWNER_ID = 'trainer-owner';
const USER_ID = 'user-1';
const PRIVATE_ID = 'private-tech';
const SYSTEM_ID = 'system-tech';

// Builds a technique link row owned by the given trainer (null = system).
const makeLink = (id, order, trainerId) => ({
  advancedTechniqueId: id,
  order,
  advancedTechnique: {
    id, key: null, name: id, description: 'd', videoUrl: null, gifUrl: null, deletedAt: null, trainerId,
  },
});

// Links of a template: one private technique of the owner, then one system technique.
const makeLinks = () => [makeLink(PRIVATE_ID, 0, OWNER_ID), makeLink(SYSTEM_ID, 1, null)];

// Builds a public exercise template authored by another trainer.
const makeExerciseTemplate = () => ({
  id: 'et-1', trainerId: OWNER_ID, isPublic: true, deletedAt: null, advancedTechniqueLinks: makeLinks(),
});

// Builds a public training template authored by another trainer.
const makeTrainingTemplate = () => ({
  id: 'tt-1',
  trainerId: OWNER_ID,
  isPublic: true,
  deletedAt: null,
  trainingTemplateExerciseTemplates: [{ id: 'j-1', advancedTechniqueLinks: makeLinks() }],
});

// Asserts only the system technique remains, reindexed to order 0.
const expectOnlySystemTechnique = (techniques) => {
  expect(techniques.map((technique) => [technique.id, technique.order])).toEqual([[SYSTEM_ID, 0]]);
};

describe('advanced technique viewer filtering in template services', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.trainer.findUnique.mockResolvedValue({ id: VIEWER_ID });
  });

  describe('exercise templates', () => {
    it('hides another trainer private technique in the list', async () => {
      prisma.exerciseTemplate.findMany.mockResolvedValue([makeExerciseTemplate()]);
      prisma.exerciseTemplate.count.mockResolvedValue(1);

      const { data } = await getExerciseTemplatesByTrainer(USER_ID);

      expectOnlySystemTechnique(data[0].advancedTechniques);
    });

    it('hides another trainer private technique in get-by-id', async () => {
      prisma.exerciseTemplate.findUnique.mockResolvedValue(makeExerciseTemplate());

      const template = await getExerciseTemplateById(USER_ID, 'et-1');

      expectOnlySystemTechnique(template.advancedTechniques);
    });

    it('keeps the private technique for its owner', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: OWNER_ID });
      prisma.exerciseTemplate.findUnique.mockResolvedValue(makeExerciseTemplate());

      const template = await getExerciseTemplateById(USER_ID, 'et-1');

      expect(template.advancedTechniques.map((technique) => technique.id)).toEqual([PRIVATE_ID, SYSTEM_ID]);
    });

    it('hides another trainer private technique in the public list', async () => {
      prisma.exerciseTemplate.findMany.mockResolvedValue([makeExerciseTemplate()]);

      const templates = await getPublicExerciseTemplates(USER_ID);

      expectOnlySystemTechnique(templates[0].advancedTechniques);
    });

    it('throws TRAINER_PROFILE_MISSING 404 on the public list without a trainer profile', async () => {
      prisma.trainer.findUnique.mockResolvedValue(null);

      await expect(getPublicExerciseTemplates(USER_ID)).rejects.toMatchObject({
        code: 'TRAINER_PROFILE_MISSING',
        statusCode: 404,
      });
      expect(prisma.exerciseTemplate.findMany).not.toHaveBeenCalled();
    });
  });

  describe('training templates', () => {
    it('hides another trainer private technique in the list', async () => {
      prisma.trainingTemplate.findMany.mockResolvedValue([makeTrainingTemplate()]);
      prisma.trainingTemplate.count.mockResolvedValue(1);

      const { data } = await getTrainingTemplatesByTrainer(USER_ID);

      expectOnlySystemTechnique(data[0].trainingTemplateExerciseTemplates[0].advancedTechniques);
    });

    it('hides another trainer private technique in get-by-id', async () => {
      prisma.trainingTemplate.findUnique.mockResolvedValue(makeTrainingTemplate());

      const template = await getTrainingTemplateById(USER_ID, 'tt-1');

      expectOnlySystemTechnique(template.trainingTemplateExerciseTemplates[0].advancedTechniques);
    });

    it('keeps the private technique for its owner', async () => {
      prisma.trainer.findUnique.mockResolvedValue({ id: OWNER_ID });
      prisma.trainingTemplate.findUnique.mockResolvedValue(makeTrainingTemplate());

      const template = await getTrainingTemplateById(USER_ID, 'tt-1');

      expect(template.trainingTemplateExerciseTemplates[0].advancedTechniques).toHaveLength(2);
    });

    it('hides another trainer private technique in the public list', async () => {
      prisma.trainingTemplate.findMany.mockResolvedValue([makeTrainingTemplate()]);

      const templates = await getPublicTrainingTemplates(USER_ID);

      expectOnlySystemTechnique(templates[0].trainingTemplateExerciseTemplates[0].advancedTechniques);
    });

    it('throws TRAINER_PROFILE_MISSING 404 on the public list without a trainer profile', async () => {
      prisma.trainer.findUnique.mockResolvedValue(null);

      await expect(getPublicTrainingTemplates(USER_ID)).rejects.toMatchObject({
        code: 'TRAINER_PROFILE_MISSING',
        statusCode: 404,
      });
      expect(prisma.trainingTemplate.findMany).not.toHaveBeenCalled();
    });
  });
});
