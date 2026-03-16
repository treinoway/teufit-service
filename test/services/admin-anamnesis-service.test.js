import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db.js', () => ({
  prisma: {
    anamnesis: { findUnique: vi.fn(), create: vi.fn(), findMany: vi.fn(), update: vi.fn() },
    anamnesisSection: {
      findUnique: vi.fn(),
      create: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    anamnesisQuestion: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    anamnesisQuestionOption: { deleteMany: vi.fn(), createMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));

import { prisma } from '../../src/db.js';
import {
  createPublicAnamnesis,
  listPublicAnamneses,
  getPublicAnamnesisById,
  updatePublicAnamnesis,
  deletePublicAnamnesis,
  addPublicSection,
  updatePublicSection,
  deletePublicSection,
  reorderPublicSections,
  addPublicQuestion,
  updatePublicQuestion,
  deletePublicQuestion,
} from '../../src/services/admin-anamnesis-service.js';
import { AnamnesisQuestionType } from '../../src/constants/anamnesis.js';

// ─── Factories ────────────────────────────────────────────────────────────────

const makeAnamnesis = (overrides = {}) => ({
  id: 'anamnesis-1',
  trainerId: null,
  title: 'Public Health Questionnaire',
  description: null,
  isGeneral: true,
  version: 1,
  parentId: null,
  deletedAt: null,
  createdAt: new Date(),
  updatedAt: null,
  ...overrides,
});

const makeSection = (overrides = {}) => ({
  id: 'section-1',
  anamnesisId: 'anamnesis-1',
  title: 'Physical Activity',
  description: null,
  order: 0,
  deletedAt: null,
  createdAt: new Date(),
  updatedAt: null,
  ...overrides,
});

const makeQuestion = (overrides = {}) => ({
  id: 'question-1',
  sectionId: 'section-1',
  text: 'Do you exercise regularly?',
  type: AnamnesisQuestionType.DICHOTOMOUS,
  required: false,
  order: 0,
  config: null,
  deletedAt: null,
  options: [],
  createdAt: new Date(),
  updatedAt: null,
  ...overrides,
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('admin-anamnesis-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── createPublicAnamnesis ─────────────────────────────────────────────────

  describe('createPublicAnamnesis', () => {
    it('creates anamnesis with isGeneral: true and trainerId: null', async () => {
      const created = makeAnamnesis({ sections: [] });

      prisma.$transaction.mockImplementation(async (fn) => {
        const tx = {
          anamnesis: { create: vi.fn().mockResolvedValue(created) },
        };
        return fn(tx);
      });

      const result = await createPublicAnamnesis({ title: 'Public Questionnaire' });

      expect(result).toEqual(created);
    });

    it('passes isGeneral: true and trainerId: null to prisma create', async () => {
      const created = makeAnamnesis({ sections: [] });
      let capturedData;

      prisma.$transaction.mockImplementation(async (fn) => {
        const txCreate = vi.fn().mockImplementation((args) => {
          capturedData = args.data;
          return Promise.resolve(created);
        });
        return fn({ anamnesis: { create: txCreate } });
      });

      await createPublicAnamnesis({ title: 'Public Questionnaire', description: 'Health check' });

      expect(capturedData).toMatchObject({
        isGeneral: true,
        trainerId: null,
        title: 'Public Questionnaire',
        description: 'Health check',
      });
    });

    it('throws INVALID_QUESTION_TYPE when a question has an unknown type', async () => {
      await expect(
        createPublicAnamnesis({
          title: 'Test',
          sections: [
            {
              title: 'Section 1',
              questions: [{ text: 'Q?', type: 'invalid_type' }],
            },
          ],
        }),
      ).rejects.toMatchObject({
        httpStatus: 400,
        error: 'INVALID_QUESTION_TYPE',
        messageCode: 'anamnesis.invalidQuestionType',
      });
    });
  });

  // ── listPublicAnamneses ───────────────────────────────────────────────────

  describe('listPublicAnamneses', () => {
    it('queries only isGeneral: true and deletedAt: null anamneses', async () => {
      prisma.anamnesis.findMany.mockResolvedValue([]);

      await listPublicAnamneses();

      expect(prisma.anamnesis.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { isGeneral: true, deletedAt: null },
        }),
      );
    });

    it('returns list of public anamneses', async () => {
      const anamneses = [makeAnamnesis(), makeAnamnesis({ id: 'anamnesis-2', title: 'Other' })];
      prisma.anamnesis.findMany.mockResolvedValue(anamneses);

      const result = await listPublicAnamneses();

      expect(result).toHaveLength(2);
    });
  });

  // ── getPublicAnamnesisById ────────────────────────────────────────────────

  describe('getPublicAnamnesisById', () => {
    it('throws 404 when anamnesis does not exist', async () => {
      prisma.anamnesis.findUnique.mockResolvedValue(null);

      await expect(getPublicAnamnesisById('anamnesis-1')).rejects.toMatchObject({
        httpStatus: 404,
        messageCode: 'anamnesis.notFound',
      });
    });

    it('throws 404 when anamnesis is soft-deleted', async () => {
      prisma.anamnesis.findUnique.mockResolvedValue(makeAnamnesis({ deletedAt: new Date() }));

      await expect(getPublicAnamnesisById('anamnesis-1')).rejects.toMatchObject({
        httpStatus: 404,
        messageCode: 'anamnesis.notFound',
      });
    });

    it('throws 404 when anamnesis is not public (isGeneral: false)', async () => {
      prisma.anamnesis.findUnique.mockResolvedValue(
        makeAnamnesis({ isGeneral: false, trainerId: 'trainer-1' }),
      );

      await expect(getPublicAnamnesisById('anamnesis-1')).rejects.toMatchObject({
        httpStatus: 404,
        messageCode: 'anamnesis.notFound',
      });
    });

    it('returns full anamnesis when it is public', async () => {
      const anamnesis = makeAnamnesis();
      prisma.anamnesis.findUnique
        .mockResolvedValueOnce(anamnesis)
        .mockResolvedValueOnce({ ...anamnesis, sections: [] });

      const result = await getPublicAnamnesisById('anamnesis-1');

      expect(result).toMatchObject({ isGeneral: true });
    });
  });

  // ── updatePublicAnamnesis ─────────────────────────────────────────────────

  describe('updatePublicAnamnesis', () => {
    it('throws 404 when anamnesis is not public', async () => {
      prisma.anamnesis.findUnique.mockResolvedValue(
        makeAnamnesis({ isGeneral: false, trainerId: 'trainer-1' }),
      );

      await expect(
        updatePublicAnamnesis('anamnesis-1', { title: 'New Title' }),
      ).rejects.toMatchObject({
        httpStatus: 404,
        messageCode: 'anamnesis.notFound',
      });
    });

    it('updates title and description without ownership check', async () => {
      prisma.anamnesis.findUnique.mockResolvedValue(makeAnamnesis());
      const updated = makeAnamnesis({ title: 'Updated Title' });
      prisma.anamnesis.update.mockResolvedValue({ ...updated, sections: [] });

      const result = await updatePublicAnamnesis('anamnesis-1', { title: 'Updated Title' });

      expect(prisma.anamnesis.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'anamnesis-1' },
          data: { title: 'Updated Title' },
        }),
      );
      expect(result.title).toBe('Updated Title');
    });

    it('updates even when the anamnesis is linked to students (no 409 guard)', async () => {
      // Admin service does NOT check assertAnamnesisNotLinked — this test confirms it
      prisma.anamnesis.findUnique.mockResolvedValue(makeAnamnesis());
      const updated = makeAnamnesis({ description: 'Updated description' });
      prisma.anamnesis.update.mockResolvedValue({ ...updated, sections: [] });

      // If there were a link guard, it would need prisma.studentAnamnesis.count — we do NOT mock it
      // If the function tries to call count, the test would fail because the mock is not set up
      await expect(
        updatePublicAnamnesis('anamnesis-1', { description: 'Updated description' }),
      ).resolves.not.toThrow();
    });
  });

  // ── deletePublicAnamnesis ─────────────────────────────────────────────────

  describe('deletePublicAnamnesis', () => {
    it('throws 404 when anamnesis does not exist', async () => {
      prisma.anamnesis.findUnique.mockResolvedValue(null);

      await expect(deletePublicAnamnesis('anamnesis-1')).rejects.toMatchObject({
        httpStatus: 404,
        messageCode: 'anamnesis.notFound',
      });
    });

    it('throws 404 when trying to delete a non-public anamnesis', async () => {
      prisma.anamnesis.findUnique.mockResolvedValue(
        makeAnamnesis({ isGeneral: false, trainerId: 'trainer-1' }),
      );

      await expect(deletePublicAnamnesis('anamnesis-1')).rejects.toMatchObject({
        httpStatus: 404,
        messageCode: 'anamnesis.notFound',
      });
    });

    it('soft-deletes anamnesis, sections, and questions in $transaction', async () => {
      prisma.anamnesis.findUnique.mockResolvedValue(makeAnamnesis());

      const sections = [{ id: 'section-1' }, { id: 'section-2' }];

      prisma.$transaction.mockImplementation(async (fn) => {
        const tx = {
          anamnesisSection: {
            findMany: vi.fn().mockResolvedValue(sections),
            updateMany: vi.fn().mockResolvedValue({ count: 2 }),
          },
          anamnesisQuestion: {
            updateMany: vi.fn().mockResolvedValue({ count: 3 }),
          },
          anamnesis: {
            update: vi.fn().mockResolvedValue(makeAnamnesis({ deletedAt: new Date() })),
          },
        };
        return fn(tx);
      });

      const result = await deletePublicAnamnesis('anamnesis-1');

      expect(result).toMatchObject({ id: 'anamnesis-1', deletedAt: expect.any(Date) });
    });
  });

  // ── addPublicSection ──────────────────────────────────────────────────────

  describe('addPublicSection', () => {
    it('throws 404 when anamnesis is not public', async () => {
      prisma.anamnesis.findUnique.mockResolvedValue(null);

      await expect(
        addPublicSection('anamnesis-1', { title: 'New Section' }),
      ).rejects.toMatchObject({
        httpStatus: 404,
        messageCode: 'anamnesis.notFound',
      });
    });

    it('creates section on a public anamnesis', async () => {
      prisma.anamnesis.findUnique.mockResolvedValue(makeAnamnesis());
      const section = makeSection();
      prisma.anamnesisSection.create.mockResolvedValue({ ...section, questions: [] });

      const result = await addPublicSection('anamnesis-1', { title: 'Physical Activity' });

      expect(result.title).toBe('Physical Activity');
      expect(prisma.anamnesisSection.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ anamnesisId: 'anamnesis-1', title: 'Physical Activity' }),
        }),
      );
    });
  });

  // ── updatePublicSection ───────────────────────────────────────────────────

  describe('updatePublicSection', () => {
    it('throws 404 when section does not belong to anamnesis', async () => {
      prisma.anamnesis.findUnique.mockResolvedValue(makeAnamnesis());
      prisma.anamnesisSection.findUnique.mockResolvedValue(
        makeSection({ anamnesisId: 'other-anamnesis' }),
      );

      await expect(
        updatePublicSection('anamnesis-1', 'section-1', { title: 'Updated' }),
      ).rejects.toMatchObject({
        httpStatus: 404,
        messageCode: 'anamnesis.section.notFound',
      });
    });

    it('updates section fields', async () => {
      prisma.anamnesis.findUnique.mockResolvedValue(makeAnamnesis());
      prisma.anamnesisSection.findUnique.mockResolvedValue(makeSection());
      const updated = makeSection({ title: 'Updated Title' });
      prisma.anamnesisSection.update.mockResolvedValue({ ...updated, questions: [] });

      const result = await updatePublicSection('anamnesis-1', 'section-1', { title: 'Updated Title' });

      expect(result.title).toBe('Updated Title');
    });
  });

  // ── deletePublicSection ───────────────────────────────────────────────────

  describe('deletePublicSection', () => {
    it('throws 404 when section not found', async () => {
      prisma.anamnesis.findUnique.mockResolvedValue(makeAnamnesis());
      prisma.anamnesisSection.findUnique.mockResolvedValue(null);

      await expect(
        deletePublicSection('anamnesis-1', 'section-1'),
      ).rejects.toMatchObject({
        httpStatus: 404,
        messageCode: 'anamnesis.section.notFound',
      });
    });

    it('soft-deletes section and cascades to questions in $transaction', async () => {
      prisma.anamnesis.findUnique.mockResolvedValue(makeAnamnesis());
      prisma.anamnesisSection.findUnique.mockResolvedValue(makeSection());

      prisma.$transaction.mockImplementation(async (fn) => {
        const tx = {
          anamnesisQuestion: { updateMany: vi.fn().mockResolvedValue({ count: 2 }) },
          anamnesisSection: {
            update: vi.fn().mockResolvedValue(makeSection({ deletedAt: new Date() })),
          },
        };
        return fn(tx);
      });

      const result = await deletePublicSection('anamnesis-1', 'section-1');

      expect(result).toMatchObject({ id: 'section-1', deletedAt: expect.any(Date) });
    });
  });

  // ── reorderPublicSections ─────────────────────────────────────────────────

  describe('reorderPublicSections', () => {
    it('updates order for each section in the ordered array', async () => {
      prisma.anamnesis.findUnique.mockResolvedValue(makeAnamnesis());

      const orderedIds = ['section-2', 'section-1'];
      prisma.$transaction.mockImplementation(async (updates) => Promise.all(updates));
      prisma.anamnesisSection.update.mockResolvedValue(makeSection());
      prisma.anamnesisSection.findMany.mockResolvedValue([
        makeSection({ id: 'section-2', order: 0 }),
        makeSection({ id: 'section-1', order: 1 }),
      ]);

      const result = await reorderPublicSections('anamnesis-1', orderedIds);

      expect(prisma.anamnesisSection.update).toHaveBeenCalledTimes(2);
      expect(prisma.anamnesisSection.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'section-2' }, data: { order: 0 } }),
      );
      expect(prisma.anamnesisSection.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'section-1' }, data: { order: 1 } }),
      );
      expect(result).toHaveLength(2);
    });
  });

  // ── addPublicQuestion ─────────────────────────────────────────────────────

  describe('addPublicQuestion', () => {
    it('throws INVALID_QUESTION_TYPE for unknown question type', async () => {
      prisma.anamnesis.findUnique.mockResolvedValue(makeAnamnesis());
      prisma.anamnesisSection.findUnique.mockResolvedValue(makeSection());

      await expect(
        addPublicQuestion('anamnesis-1', 'section-1', {
          text: 'Question?',
          type: 'unknown_type',
        }),
      ).rejects.toMatchObject({
        httpStatus: 400,
        error: 'INVALID_QUESTION_TYPE',
      });
    });

    it('creates a dichotomous question', async () => {
      prisma.anamnesis.findUnique.mockResolvedValue(makeAnamnesis());
      prisma.anamnesisSection.findUnique.mockResolvedValue(makeSection());
      const question = makeQuestion();
      prisma.anamnesisQuestion.create.mockResolvedValue({ ...question, options: [] });

      const result = await addPublicQuestion('anamnesis-1', 'section-1', {
        text: 'Do you exercise regularly?',
        type: AnamnesisQuestionType.DICHOTOMOUS,
      });

      expect(result.type).toBe(AnamnesisQuestionType.DICHOTOMOUS);
    });

    it('throws 404 when section does not belong to anamnesis', async () => {
      prisma.anamnesis.findUnique.mockResolvedValue(makeAnamnesis());
      prisma.anamnesisSection.findUnique.mockResolvedValue(
        makeSection({ anamnesisId: 'other-anamnesis' }),
      );

      await expect(
        addPublicQuestion('anamnesis-1', 'section-1', {
          text: 'Q?',
          type: AnamnesisQuestionType.FREE_TEXT,
        }),
      ).rejects.toMatchObject({
        httpStatus: 404,
        messageCode: 'anamnesis.section.notFound',
      });
    });
  });

  // ── updatePublicQuestion ──────────────────────────────────────────────────

  describe('updatePublicQuestion', () => {
    it('throws 404 when question does not exist', async () => {
      prisma.anamnesis.findUnique.mockResolvedValue(makeAnamnesis());
      prisma.anamnesisSection.findUnique.mockResolvedValue(makeSection());
      prisma.anamnesisQuestion.findUnique.mockResolvedValue(null);

      await expect(
        updatePublicQuestion('anamnesis-1', 'section-1', 'question-1', { text: 'Updated?' }),
      ).rejects.toMatchObject({
        httpStatus: 404,
        messageCode: 'anamnesis.question.notFound',
      });
    });

    it('replaces options in $transaction when options array is provided', async () => {
      prisma.anamnesis.findUnique.mockResolvedValue(makeAnamnesis());
      prisma.anamnesisSection.findUnique.mockResolvedValue(makeSection());
      prisma.anamnesisQuestion.findUnique.mockResolvedValue(
        makeQuestion({ type: AnamnesisQuestionType.SINGLE_CHOICE }),
      );

      const updatedQuestion = makeQuestion({ text: 'Updated?' });
      prisma.$transaction.mockImplementation(async (fn) => {
        const tx = {
          anamnesisQuestionOption: {
            deleteMany: vi.fn().mockResolvedValue({ count: 2 }),
            createMany: vi.fn().mockResolvedValue({ count: 1 }),
          },
          anamnesisQuestion: {
            update: vi.fn().mockResolvedValue({ ...updatedQuestion, options: [] }),
          },
        };
        return fn(tx);
      });

      await updatePublicQuestion('anamnesis-1', 'section-1', 'question-1', {
        text: 'Updated?',
        options: [{ text: 'New Option A' }],
      });

      expect(prisma.$transaction).toHaveBeenCalled();
    });
  });

  // ── deletePublicQuestion ──────────────────────────────────────────────────

  describe('deletePublicQuestion', () => {
    it('soft-deletes the question', async () => {
      prisma.anamnesis.findUnique.mockResolvedValue(makeAnamnesis());
      prisma.anamnesisSection.findUnique.mockResolvedValue(makeSection());
      prisma.anamnesisQuestion.findUnique.mockResolvedValue(makeQuestion());
      prisma.anamnesisQuestion.update.mockResolvedValue(makeQuestion({ deletedAt: new Date() }));

      const result = await deletePublicQuestion('anamnesis-1', 'section-1', 'question-1');

      expect(prisma.anamnesisQuestion.update).toHaveBeenCalledWith({
        where: { id: 'question-1' },
        data: { deletedAt: expect.any(Date) },
      });
      expect(result).toMatchObject({ id: 'question-1', deletedAt: expect.any(Date) });
    });

    it('throws 404 when question belongs to a different section', async () => {
      prisma.anamnesis.findUnique.mockResolvedValue(makeAnamnesis());
      prisma.anamnesisSection.findUnique.mockResolvedValue(makeSection());
      prisma.anamnesisQuestion.findUnique.mockResolvedValue(
        makeQuestion({ sectionId: 'other-section' }),
      );

      await expect(
        deletePublicQuestion('anamnesis-1', 'section-1', 'question-1'),
      ).rejects.toMatchObject({
        httpStatus: 404,
        messageCode: 'anamnesis.question.notFound',
      });
    });
  });
});
