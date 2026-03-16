import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db.js', () => ({
  prisma: {
    trainer: { findUnique: vi.fn() },
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
    studentAnamnesis: {
      create: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      delete: vi.fn(),
      count: vi.fn(),
    },
    trainerStudent: { findUnique: vi.fn() },
    anamnesisResponse: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
    anamnesisAnswer: {
      deleteMany: vi.fn(),
      createMany: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

import { prisma } from '../../src/db.js';
import {
  createAnamnesis,
  listAnamneses,
  getAnamnesisById,
  updateAnamnesis,
  deleteAnamnesis,
  addSection,
  updateSection,
  deleteSection,
  reorderSections,
  addQuestion,
  updateQuestion,
  deleteQuestion,
  linkAnamnesisToStudent,
  listStudentAnamneses,
  unlinkAnamnesisFromStudent,
  getMyAnamneses,
  forkAnamnesis,
  copyAnamnesis,
  submitAnamnesisResponse,
  getMyAnamnesisResponse,
  getStudentAnamnesisResponse,
} from '../../src/services/anamnesis-service.js';
import { AnamnesisQuestionType } from '../../src/constants/anamnesis.js';

// ─── Factories ────────────────────────────────────────────────────────────────

const makeTrainer = (overrides = {}) => ({ id: 'trainer-1', ...overrides });

const makeAnamnesis = (overrides = {}) => ({
  id: 'anamnesis-1',
  trainerId: 'trainer-1',
  title: 'Health Questionnaire',
  description: null,
  isGeneral: false,
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

const makeStudentAnamnesisLink = (overrides = {}) => ({
  id: 'link-1',
  anamnesisId: 'anamnesis-1',
  studentId: 'student-1',
  trainerId: 'trainer-1',
  createdAt: new Date(),
  ...overrides,
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('anamnesis-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── createAnamnesis ──────────────────────────────────────────────────────

  describe('createAnamnesis', () => {
    it('throws 404 when trainer profile does not exist', async () => {
      prisma.trainer.findUnique.mockResolvedValue(null);

      await expect(createAnamnesis('user-1', { title: 'Test' })).rejects.toMatchObject({
        httpStatus: 404,
        messageCode: 'trainer.notFound',
      });
    });

    it('creates anamnesis with nested sections in $transaction', async () => {
      prisma.trainer.findUnique.mockResolvedValue(makeTrainer());
      const created = makeAnamnesis({ sections: [] });

      prisma.$transaction.mockImplementation(async (fn) => {
        const tx = {
          anamnesis: { create: vi.fn().mockResolvedValue(created) },
        };
        return fn(tx);
      });

      const result = await createAnamnesis('user-1', { title: 'Health Questionnaire' });

      expect(result).toEqual(created);
    });

    it('throws INVALID_QUESTION_TYPE when a question has an unknown type', async () => {
      prisma.trainer.findUnique.mockResolvedValue(makeTrainer());

      prisma.$transaction.mockImplementation(async (fn) => {
        const tx = {
          anamnesis: {
            create: vi.fn().mockRejectedValue(
              (() => {
                const err = new Error('forced');
                return err;
              })()
            ),
          },
        };
        // The validation happens before the transaction call for question types
        return fn(tx);
      });

      await expect(
        createAnamnesis('user-1', {
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

  // ── listAnamneses ────────────────────────────────────────────────────────

  describe('listAnamneses', () => {
    it('throws 404 when trainer profile does not exist', async () => {
      prisma.trainer.findUnique.mockResolvedValue(null);

      await expect(listAnamneses('user-1')).rejects.toMatchObject({
        httpStatus: 404,
        messageCode: 'trainer.notFound',
      });
    });

    it('queries for own anamneses and general anamneses', async () => {
      prisma.trainer.findUnique.mockResolvedValue(makeTrainer());
      prisma.anamnesis.findMany.mockResolvedValue([]);

      await listAnamneses('user-1');

      expect(prisma.anamnesis.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            deletedAt: null,
            OR: expect.arrayContaining([
              { trainerId: 'trainer-1' },
              { isGeneral: true },
            ]),
          }),
        }),
      );
    });

    it('returns combined list of own and general anamneses', async () => {
      prisma.trainer.findUnique.mockResolvedValue(makeTrainer());
      const anamneses = [makeAnamnesis(), makeAnamnesis({ id: 'gen-1', trainerId: null, isGeneral: true })];
      prisma.anamnesis.findMany.mockResolvedValue(anamneses);

      const result = await listAnamneses('user-1');

      expect(result).toHaveLength(2);
    });
  });

  // ── getAnamnesisById ─────────────────────────────────────────────────────

  describe('getAnamnesisById', () => {
    it('throws 404 when anamnesis does not exist', async () => {
      prisma.trainer.findUnique.mockResolvedValue(makeTrainer());
      prisma.anamnesis.findUnique.mockResolvedValue(null);

      await expect(getAnamnesisById('user-1', 'anamnesis-1')).rejects.toMatchObject({
        httpStatus: 404,
        messageCode: 'anamnesis.notFound',
      });
    });

    it('throws 404 when anamnesis is soft-deleted', async () => {
      prisma.trainer.findUnique.mockResolvedValue(makeTrainer());
      prisma.anamnesis.findUnique.mockResolvedValue(makeAnamnesis({ deletedAt: new Date() }));

      await expect(getAnamnesisById('user-1', 'anamnesis-1')).rejects.toMatchObject({
        httpStatus: 404,
        messageCode: 'anamnesis.notFound',
      });
    });

    it("throws 403 when accessing another trainer's private anamnesis", async () => {
      prisma.trainer.findUnique.mockResolvedValue(makeTrainer({ id: 'trainer-2' }));
      prisma.anamnesis.findUnique.mockResolvedValue(makeAnamnesis({ trainerId: 'trainer-1' }));

      await expect(getAnamnesisById('user-2', 'anamnesis-1')).rejects.toMatchObject({
        httpStatus: 403,
        messageCode: 'anamnesis.forbidden.notOwner',
      });
    });

    it('allows access to general anamneses regardless of trainer', async () => {
      prisma.trainer.findUnique.mockResolvedValue(makeTrainer({ id: 'trainer-2' }));
      const generalAnamnesis = makeAnamnesis({ trainerId: null, isGeneral: true });
      // First call returns the general anamnesis (findAnamnesisOrThrow)
      // Second call returns it with full include
      prisma.anamnesis.findUnique
        .mockResolvedValueOnce(generalAnamnesis)
        .mockResolvedValueOnce({ ...generalAnamnesis, sections: [] });

      const result = await getAnamnesisById('user-2', 'anamnesis-1');

      expect(result).toMatchObject({ isGeneral: true });
    });

    it('allows access to own private anamnesis', async () => {
      prisma.trainer.findUnique.mockResolvedValue(makeTrainer());
      const anamnesis = makeAnamnesis();
      prisma.anamnesis.findUnique
        .mockResolvedValueOnce(anamnesis)
        .mockResolvedValueOnce({ ...anamnesis, sections: [] });

      const result = await getAnamnesisById('user-1', 'anamnesis-1');

      expect(result).toMatchObject({ id: 'anamnesis-1' });
    });
  });

  // ── updateAnamnesis ──────────────────────────────────────────────────────

  describe('updateAnamnesis', () => {
    it('throws 403 when trying to update a general anamnesis', async () => {
      prisma.trainer.findUnique.mockResolvedValue(makeTrainer());
      prisma.anamnesis.findUnique.mockResolvedValue(
        makeAnamnesis({ trainerId: null, isGeneral: true }),
      );

      await expect(
        updateAnamnesis('user-1', 'anamnesis-1', { title: 'New Title' }),
      ).rejects.toMatchObject({
        httpStatus: 403,
        messageCode: 'anamnesis.forbidden.general',
      });
    });

    it("throws 403 when updating another trainer's anamnesis", async () => {
      prisma.trainer.findUnique.mockResolvedValue(makeTrainer({ id: 'trainer-2' }));
      prisma.anamnesis.findUnique.mockResolvedValue(makeAnamnesis({ trainerId: 'trainer-1' }));

      await expect(
        updateAnamnesis('user-2', 'anamnesis-1', { title: 'New Title' }),
      ).rejects.toMatchObject({
        httpStatus: 403,
        messageCode: 'anamnesis.forbidden.notOwner',
      });
    });

    it('updates title and description for owned anamnesis', async () => {
      prisma.trainer.findUnique.mockResolvedValue(makeTrainer());
      prisma.anamnesis.findUnique.mockResolvedValue(makeAnamnesis());
      const updated = makeAnamnesis({ title: 'Updated Title' });
      prisma.anamnesis.update.mockResolvedValue({ ...updated, sections: [] });

      const result = await updateAnamnesis('user-1', 'anamnesis-1', { title: 'Updated Title' });

      expect(prisma.anamnesis.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'anamnesis-1' },
          data: { title: 'Updated Title' },
        }),
      );
      expect(result.title).toBe('Updated Title');
    });
  });

  // ── deleteAnamnesis ──────────────────────────────────────────────────────

  describe('deleteAnamnesis', () => {
    it('throws 403 when deleting a general anamnesis', async () => {
      prisma.trainer.findUnique.mockResolvedValue(makeTrainer());
      prisma.anamnesis.findUnique.mockResolvedValue(
        makeAnamnesis({ trainerId: null, isGeneral: true }),
      );

      await expect(deleteAnamnesis('user-1', 'anamnesis-1')).rejects.toMatchObject({
        httpStatus: 403,
        messageCode: 'anamnesis.forbidden.general',
      });
    });

    it('soft-deletes anamnesis, sections, and questions in $transaction', async () => {
      prisma.trainer.findUnique.mockResolvedValue(makeTrainer());
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

      const result = await deleteAnamnesis('user-1', 'anamnesis-1');

      expect(result).toMatchObject({ id: 'anamnesis-1', deletedAt: expect.any(Date) });
    });
  });

  // ── addSection ───────────────────────────────────────────────────────────

  describe('addSection', () => {
    it('throws 403 when adding section to general anamnesis', async () => {
      prisma.trainer.findUnique.mockResolvedValue(makeTrainer());
      prisma.anamnesis.findUnique.mockResolvedValue(
        makeAnamnesis({ trainerId: null, isGeneral: true }),
      );

      await expect(
        addSection('user-1', 'anamnesis-1', { title: 'New Section' }),
      ).rejects.toMatchObject({
        httpStatus: 403,
        messageCode: 'anamnesis.forbidden.general',
      });
    });

    it('creates section with questions', async () => {
      prisma.trainer.findUnique.mockResolvedValue(makeTrainer());
      prisma.anamnesis.findUnique.mockResolvedValue(makeAnamnesis());
      const section = makeSection();
      prisma.anamnesisSection.create.mockResolvedValue({ ...section, questions: [] });

      const result = await addSection('user-1', 'anamnesis-1', { title: 'Physical Activity' });

      expect(result.title).toBe('Physical Activity');
      expect(prisma.anamnesisSection.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            anamnesisId: 'anamnesis-1',
            title: 'Physical Activity',
          }),
        }),
      );
    });
  });

  // ── updateSection ────────────────────────────────────────────────────────

  describe('updateSection', () => {
    it('throws 404 when section does not exist', async () => {
      prisma.trainer.findUnique.mockResolvedValue(makeTrainer());
      prisma.anamnesis.findUnique.mockResolvedValue(makeAnamnesis());
      prisma.anamnesisSection.findUnique.mockResolvedValue(null);

      await expect(
        updateSection('user-1', 'anamnesis-1', 'section-1', { title: 'Updated' }),
      ).rejects.toMatchObject({
        httpStatus: 404,
        messageCode: 'anamnesis.section.notFound',
      });
    });

    it('throws 404 when section belongs to another anamnesis', async () => {
      prisma.trainer.findUnique.mockResolvedValue(makeTrainer());
      prisma.anamnesis.findUnique.mockResolvedValue(makeAnamnesis());
      prisma.anamnesisSection.findUnique.mockResolvedValue(
        makeSection({ anamnesisId: 'other-anamnesis' }),
      );

      await expect(
        updateSection('user-1', 'anamnesis-1', 'section-1', { title: 'Updated' }),
      ).rejects.toMatchObject({
        httpStatus: 404,
        messageCode: 'anamnesis.section.notFound',
      });
    });

    it('updates section fields', async () => {
      prisma.trainer.findUnique.mockResolvedValue(makeTrainer());
      prisma.anamnesis.findUnique.mockResolvedValue(makeAnamnesis());
      prisma.anamnesisSection.findUnique.mockResolvedValue(makeSection());
      const updated = makeSection({ title: 'Updated Title' });
      prisma.anamnesisSection.update.mockResolvedValue({ ...updated, questions: [] });

      const result = await updateSection('user-1', 'anamnesis-1', 'section-1', {
        title: 'Updated Title',
      });

      expect(result.title).toBe('Updated Title');
    });
  });

  // ── deleteSection ────────────────────────────────────────────────────────

  describe('deleteSection', () => {
    it('soft-deletes section and cascades to questions in $transaction', async () => {
      prisma.trainer.findUnique.mockResolvedValue(makeTrainer());
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

      const result = await deleteSection('user-1', 'anamnesis-1', 'section-1');

      expect(result).toMatchObject({ id: 'section-1', deletedAt: expect.any(Date) });
    });
  });

  // ── reorderSections ──────────────────────────────────────────────────────

  describe('reorderSections', () => {
    it('updates order for each section id in the array', async () => {
      prisma.trainer.findUnique.mockResolvedValue(makeTrainer());
      prisma.anamnesis.findUnique.mockResolvedValue(makeAnamnesis());

      const orderedIds = ['section-2', 'section-1'];
      prisma.$transaction.mockImplementation(async (updates) => {
        // The service passes an array of update promises
        return Promise.all(updates);
      });

      prisma.anamnesisSection.update.mockResolvedValue(makeSection());
      prisma.anamnesisSection.findMany.mockResolvedValue([makeSection(), makeSection({ id: 'section-2', order: 1 })]);

      const result = await reorderSections('user-1', 'anamnesis-1', orderedIds);

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

  // ── addQuestion ──────────────────────────────────────────────────────────

  describe('addQuestion', () => {
    it('throws INVALID_QUESTION_TYPE for unknown question type', async () => {
      prisma.trainer.findUnique.mockResolvedValue(makeTrainer());
      prisma.anamnesis.findUnique.mockResolvedValue(makeAnamnesis());
      prisma.anamnesisSection.findUnique.mockResolvedValue(makeSection());

      await expect(
        addQuestion('user-1', 'anamnesis-1', 'section-1', {
          text: 'Question?',
          type: 'unknown_type',
        }),
      ).rejects.toMatchObject({
        httpStatus: 400,
        error: 'INVALID_QUESTION_TYPE',
      });
    });

    it('creates a free_text question without options', async () => {
      prisma.trainer.findUnique.mockResolvedValue(makeTrainer());
      prisma.anamnesis.findUnique.mockResolvedValue(makeAnamnesis());
      prisma.anamnesisSection.findUnique.mockResolvedValue(makeSection());
      const question = makeQuestion();
      prisma.anamnesisQuestion.create.mockResolvedValue({ ...question, options: [] });

      const result = await addQuestion('user-1', 'anamnesis-1', 'section-1', {
        text: 'Do you exercise regularly?',
        type: AnamnesisQuestionType.DICHOTOMOUS,
      });

      expect(result.type).toBe(AnamnesisQuestionType.DICHOTOMOUS);
      expect(prisma.anamnesisQuestion.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            sectionId: 'section-1',
            text: 'Do you exercise regularly?',
            type: AnamnesisQuestionType.DICHOTOMOUS,
          }),
        }),
      );
    });

    it('creates a multiple_choice question with options', async () => {
      prisma.trainer.findUnique.mockResolvedValue(makeTrainer());
      prisma.anamnesis.findUnique.mockResolvedValue(makeAnamnesis());
      prisma.anamnesisSection.findUnique.mockResolvedValue(makeSection());
      const question = makeQuestion({
        type: AnamnesisQuestionType.MULTIPLE_CHOICE,
        options: [{ id: 'opt-1', text: 'Option A', order: 0 }],
      });
      prisma.anamnesisQuestion.create.mockResolvedValue(question);

      const result = await addQuestion('user-1', 'anamnesis-1', 'section-1', {
        text: 'Which sports do you practice?',
        type: AnamnesisQuestionType.MULTIPLE_CHOICE,
        options: [{ text: 'Option A' }],
      });

      expect(result.type).toBe(AnamnesisQuestionType.MULTIPLE_CHOICE);
    });
  });

  // ── updateQuestion ───────────────────────────────────────────────────────

  describe('updateQuestion', () => {
    it('throws 404 when question does not exist', async () => {
      prisma.trainer.findUnique.mockResolvedValue(makeTrainer());
      prisma.anamnesis.findUnique.mockResolvedValue(makeAnamnesis());
      prisma.anamnesisSection.findUnique.mockResolvedValue(makeSection());
      prisma.anamnesisQuestion.findUnique.mockResolvedValue(null);

      await expect(
        updateQuestion('user-1', 'anamnesis-1', 'section-1', 'question-1', { text: 'Updated?' }),
      ).rejects.toMatchObject({
        httpStatus: 404,
        messageCode: 'anamnesis.question.notFound',
      });
    });

    it('replaces options in $transaction when options array is provided', async () => {
      prisma.trainer.findUnique.mockResolvedValue(makeTrainer());
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
            findUnique: vi.fn().mockResolvedValue({ type: AnamnesisQuestionType.SINGLE_CHOICE }),
          },
        };
        return fn(tx);
      });

      await updateQuestion('user-1', 'anamnesis-1', 'section-1', 'question-1', {
        text: 'Updated?',
        options: [{ text: 'New Option A' }],
      });

      expect(prisma.$transaction).toHaveBeenCalled();
    });

    it('throws INVALID_QUESTION_TYPE when updating to an invalid type', async () => {
      prisma.trainer.findUnique.mockResolvedValue(makeTrainer());
      prisma.anamnesis.findUnique.mockResolvedValue(makeAnamnesis());
      prisma.anamnesisSection.findUnique.mockResolvedValue(makeSection());
      prisma.anamnesisQuestion.findUnique.mockResolvedValue(makeQuestion());

      await expect(
        updateQuestion('user-1', 'anamnesis-1', 'section-1', 'question-1', {
          type: 'not_a_valid_type',
        }),
      ).rejects.toMatchObject({
        httpStatus: 400,
        error: 'INVALID_QUESTION_TYPE',
      });
    });
  });

  // ── deleteQuestion ───────────────────────────────────────────────────────

  describe('deleteQuestion', () => {
    it('soft-deletes the question by setting deletedAt', async () => {
      prisma.trainer.findUnique.mockResolvedValue(makeTrainer());
      prisma.anamnesis.findUnique.mockResolvedValue(makeAnamnesis());
      prisma.anamnesisSection.findUnique.mockResolvedValue(makeSection());
      prisma.anamnesisQuestion.findUnique.mockResolvedValue(makeQuestion());
      prisma.anamnesisQuestion.update.mockResolvedValue(makeQuestion({ deletedAt: new Date() }));

      const result = await deleteQuestion('user-1', 'anamnesis-1', 'section-1', 'question-1');

      expect(prisma.anamnesisQuestion.update).toHaveBeenCalledWith({
        where: { id: 'question-1' },
        data: { deletedAt: expect.any(Date) },
      });
      expect(result).toMatchObject({ id: 'question-1', deletedAt: expect.any(Date) });
    });
  });

  // ── linkAnamnesisToStudent ───────────────────────────────────────────────

  describe('linkAnamnesisToStudent', () => {
    it('throws 404 when trainer-student link does not exist', async () => {
      prisma.trainer.findUnique.mockResolvedValue(makeTrainer());
      prisma.trainerStudent.findUnique.mockResolvedValue(null);

      await expect(
        linkAnamnesisToStudent('user-1', 'student-1', { anamnesisId: 'anamnesis-1' }),
      ).rejects.toMatchObject({
        httpStatus: 404,
        messageCode: 'student.notFound',
      });
    });

    it("throws 403 when linking another trainer's private anamnesis", async () => {
      prisma.trainer.findUnique.mockResolvedValue(makeTrainer({ id: 'trainer-2' }));
      prisma.trainerStudent.findUnique.mockResolvedValue({ trainerId: 'trainer-2', studentId: 'student-1' });
      prisma.anamnesis.findUnique.mockResolvedValue(makeAnamnesis({ trainerId: 'trainer-1' }));

      await expect(
        linkAnamnesisToStudent('user-2', 'student-1', { anamnesisId: 'anamnesis-1' }),
      ).rejects.toMatchObject({
        httpStatus: 403,
        messageCode: 'anamnesis.forbidden.notOwner',
      });
    });

    it('throws 409 on duplicate link (P2002)', async () => {
      prisma.trainer.findUnique.mockResolvedValue(makeTrainer());
      prisma.trainerStudent.findUnique.mockResolvedValue({ trainerId: 'trainer-1', studentId: 'student-1' });
      prisma.anamnesis.findUnique.mockResolvedValue(makeAnamnesis());

      const prismaError = new Error('Unique constraint violation');
      prismaError.code = 'P2002';
      prisma.studentAnamnesis.create.mockRejectedValue(prismaError);

      await expect(
        linkAnamnesisToStudent('user-1', 'student-1', { anamnesisId: 'anamnesis-1' }),
      ).rejects.toMatchObject({
        httpStatus: 409,
        messageCode: 'anamnesis.alreadyLinked',
      });
    });

    it('creates link for own anamnesis', async () => {
      prisma.trainer.findUnique.mockResolvedValue(makeTrainer());
      prisma.trainerStudent.findUnique.mockResolvedValue({ trainerId: 'trainer-1', studentId: 'student-1' });
      prisma.anamnesis.findUnique.mockResolvedValue(makeAnamnesis());
      const link = makeStudentAnamnesisLink();
      prisma.studentAnamnesis.create.mockResolvedValue({
        ...link,
        anamnesis: { id: 'anamnesis-1', title: 'Health Questionnaire', isGeneral: false },
      });

      const result = await linkAnamnesisToStudent('user-1', 'student-1', { anamnesisId: 'anamnesis-1' });

      expect(result).toMatchObject({ anamnesisId: 'anamnesis-1', studentId: 'student-1' });
    });

    it('creates link for a general anamnesis regardless of trainer', async () => {
      prisma.trainer.findUnique.mockResolvedValue(makeTrainer({ id: 'trainer-2' }));
      prisma.trainerStudent.findUnique.mockResolvedValue({ trainerId: 'trainer-2', studentId: 'student-1' });
      prisma.anamnesis.findUnique.mockResolvedValue(
        makeAnamnesis({ trainerId: null, isGeneral: true }),
      );
      const link = makeStudentAnamnesisLink({ trainerId: 'trainer-2' });
      prisma.studentAnamnesis.create.mockResolvedValue({
        ...link,
        anamnesis: { id: 'anamnesis-1', title: 'Health Questionnaire', isGeneral: true },
      });

      const result = await linkAnamnesisToStudent('user-2', 'student-1', { anamnesisId: 'anamnesis-1' });

      expect(prisma.studentAnamnesis.create).toHaveBeenCalled();
      expect(result).toBeDefined();
    });
  });

  // ── listStudentAnamneses ─────────────────────────────────────────────────

  describe('listStudentAnamneses', () => {
    it('throws 404 when student is not linked to trainer', async () => {
      prisma.trainer.findUnique.mockResolvedValue(makeTrainer());
      prisma.trainerStudent.findUnique.mockResolvedValue(null);

      await expect(listStudentAnamneses('user-1', 'student-1')).rejects.toMatchObject({
        httpStatus: 404,
        messageCode: 'student.notFound',
      });
    });

    it('returns linked anamneses for the student', async () => {
      prisma.trainer.findUnique.mockResolvedValue(makeTrainer());
      prisma.trainerStudent.findUnique.mockResolvedValue({ trainerId: 'trainer-1', studentId: 'student-1' });
      const links = [makeStudentAnamnesisLink()];
      prisma.studentAnamnesis.findMany.mockResolvedValue(links);

      const result = await listStudentAnamneses('user-1', 'student-1');

      expect(result).toEqual(links);
      expect(prisma.studentAnamnesis.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { studentId: 'student-1', trainerId: 'trainer-1' },
        }),
      );
    });
  });

  // ── unlinkAnamnesisFromStudent ───────────────────────────────────────────

  describe('unlinkAnamnesisFromStudent', () => {
    it('throws 404 when the link does not exist', async () => {
      prisma.trainer.findUnique.mockResolvedValue(makeTrainer());
      prisma.trainerStudent.findUnique.mockResolvedValue({ trainerId: 'trainer-1', studentId: 'student-1' });
      prisma.studentAnamnesis.findUnique.mockResolvedValue(null);

      await expect(
        unlinkAnamnesisFromStudent('user-1', 'student-1', 'anamnesis-1'),
      ).rejects.toMatchObject({
        httpStatus: 404,
        messageCode: 'anamnesis.notFound',
      });
    });

    it('hard-deletes the link record', async () => {
      prisma.trainer.findUnique.mockResolvedValue(makeTrainer());
      prisma.trainerStudent.findUnique.mockResolvedValue({ trainerId: 'trainer-1', studentId: 'student-1' });
      const link = makeStudentAnamnesisLink();
      prisma.studentAnamnesis.findUnique.mockResolvedValue(link);
      prisma.studentAnamnesis.delete.mockResolvedValue(link);

      const result = await unlinkAnamnesisFromStudent('user-1', 'student-1', 'anamnesis-1');

      expect(prisma.studentAnamnesis.delete).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            anamnesisId_studentId_trainerId: {
              anamnesisId: 'anamnesis-1',
              studentId: 'student-1',
              trainerId: 'trainer-1',
            },
          }),
        }),
      );
      expect(result).toMatchObject({ id: 'link-1' });
    });
  });

  // ── getMyAnamneses ───────────────────────────────────────────────────────

  describe('getMyAnamneses', () => {
    it('returns all anamneses linked to the student', async () => {
      const links = [
        {
          ...makeStudentAnamnesisLink(),
          anamnesis: { id: 'anamnesis-1', title: 'Health Questionnaire', sections: [] },
          trainer: { id: 'trainer-1', user: { firstName: 'John', lastName: 'Doe', avatarUrl: null } },
        },
      ];
      prisma.studentAnamnesis.findMany.mockResolvedValue(links);

      const result = await getMyAnamneses('student-1');

      expect(result).toEqual(links);
      expect(prisma.studentAnamnesis.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { studentId: 'student-1' },
        }),
      );
    });

    it('returns empty array when student has no linked anamneses', async () => {
      prisma.studentAnamnesis.findMany.mockResolvedValue([]);

      const result = await getMyAnamneses('student-1');

      expect(result).toEqual([]);
    });
  });

  // ── assertAnamnesisNotLinked guard ───────────────────────────────────────

  describe('assertAnamnesisNotLinked guard', () => {
    const linkedCount = 1;

    function setupOwnedAnamnesis() {
      prisma.trainer.findUnique.mockResolvedValue(makeTrainer());
      prisma.anamnesis.findUnique.mockResolvedValue(makeAnamnesis());
      prisma.studentAnamnesis.count.mockResolvedValue(linkedCount);
    }

    it('deleteAnamnesis — throws 409 when linked', async () => {
      setupOwnedAnamnesis();

      await expect(deleteAnamnesis('user-1', 'anamnesis-1')).rejects.toMatchObject({
        httpStatus: 409,
        error: 'ANAMNESIS_HAS_STUDENT_LINKS',
        messageCode: 'anamnesis.hasStudentLinks',
      });
    });

    it('addSection — throws 409 when linked', async () => {
      setupOwnedAnamnesis();

      await expect(addSection('user-1', 'anamnesis-1', { title: 'X' })).rejects.toMatchObject({
        httpStatus: 409,
        error: 'ANAMNESIS_HAS_STUDENT_LINKS',
      });
    });

    it('updateSection — throws 409 when linked', async () => {
      setupOwnedAnamnesis();

      await expect(
        updateSection('user-1', 'anamnesis-1', 'section-1', { title: 'X' }),
      ).rejects.toMatchObject({
        httpStatus: 409,
        error: 'ANAMNESIS_HAS_STUDENT_LINKS',
      });
    });

    it('deleteSection — throws 409 when linked', async () => {
      setupOwnedAnamnesis();

      await expect(
        deleteSection('user-1', 'anamnesis-1', 'section-1'),
      ).rejects.toMatchObject({
        httpStatus: 409,
        error: 'ANAMNESIS_HAS_STUDENT_LINKS',
      });
    });

    it('reorderSections — throws 409 when linked', async () => {
      setupOwnedAnamnesis();

      await expect(
        reorderSections('user-1', 'anamnesis-1', ['section-1', 'section-2']),
      ).rejects.toMatchObject({
        httpStatus: 409,
        error: 'ANAMNESIS_HAS_STUDENT_LINKS',
      });
    });

    it('addQuestion — throws 409 when linked', async () => {
      setupOwnedAnamnesis();

      await expect(
        addQuestion('user-1', 'anamnesis-1', 'section-1', {
          text: 'Q?',
          type: AnamnesisQuestionType.FREE_TEXT,
        }),
      ).rejects.toMatchObject({
        httpStatus: 409,
        error: 'ANAMNESIS_HAS_STUDENT_LINKS',
      });
    });

    it('updateQuestion — throws 409 when linked', async () => {
      setupOwnedAnamnesis();

      await expect(
        updateQuestion('user-1', 'anamnesis-1', 'section-1', 'question-1', { text: 'Updated?' }),
      ).rejects.toMatchObject({
        httpStatus: 409,
        error: 'ANAMNESIS_HAS_STUDENT_LINKS',
      });
    });

    it('deleteQuestion — throws 409 when linked', async () => {
      setupOwnedAnamnesis();

      await expect(
        deleteQuestion('user-1', 'anamnesis-1', 'section-1', 'question-1'),
      ).rejects.toMatchObject({
        httpStatus: 409,
        error: 'ANAMNESIS_HAS_STUDENT_LINKS',
      });
    });
  });

  // ── forkAnamnesis ────────────────────────────────────────────────────────

  describe('forkAnamnesis', () => {
    it('throws 404 when anamnesis does not exist', async () => {
      prisma.trainer.findUnique.mockResolvedValue(makeTrainer());
      prisma.anamnesis.findUnique.mockResolvedValue(null);

      await expect(forkAnamnesis('user-1', 'anamnesis-1')).rejects.toMatchObject({
        httpStatus: 404,
        messageCode: 'anamnesis.notFound',
      });
    });

    it('throws 403 when trying to fork a general anamnesis', async () => {
      prisma.trainer.findUnique.mockResolvedValue(makeTrainer());
      prisma.anamnesis.findUnique.mockResolvedValue(
        makeAnamnesis({ trainerId: null, isGeneral: true }),
      );

      await expect(forkAnamnesis('user-1', 'anamnesis-1')).rejects.toMatchObject({
        httpStatus: 403,
        messageCode: 'anamnesis.forbidden.general',
      });
    });

    it("throws 403 when forking another trainer's anamnesis", async () => {
      prisma.trainer.findUnique.mockResolvedValue(makeTrainer({ id: 'trainer-2' }));
      prisma.anamnesis.findUnique.mockResolvedValue(makeAnamnesis({ trainerId: 'trainer-1' }));

      await expect(forkAnamnesis('user-2', 'anamnesis-1')).rejects.toMatchObject({
        httpStatus: 403,
        messageCode: 'anamnesis.forbidden.notOwner',
      });
    });

    it('creates fork with version+1 and parentId set', async () => {
      prisma.trainer.findUnique.mockResolvedValue(makeTrainer());
      const source = makeAnamnesis({ version: 1 });
      prisma.anamnesis.findUnique
        .mockResolvedValueOnce(source) // findAnamnesisOrThrow
        .mockResolvedValueOnce({ ...source, sections: [] }); // load with sections

      const forkedAnamnesis = makeAnamnesis({
        id: 'forked-1',
        version: 2,
        parentId: 'anamnesis-1',
        sections: [],
      });

      prisma.$transaction.mockImplementation(async (fn) => {
        const tx = {
          anamnesis: {
            create: vi.fn().mockResolvedValue({ id: 'forked-1' }),
            findUnique: vi.fn().mockResolvedValue(forkedAnamnesis),
          },
          anamnesisSection: { create: vi.fn() },
          anamnesisQuestion: { create: vi.fn() },
          anamnesisQuestionOption: { createMany: vi.fn() },
        };
        return fn(tx);
      });

      const result = await forkAnamnesis('user-1', 'anamnesis-1');

      expect(result).toMatchObject({ id: 'forked-1', version: 2, parentId: 'anamnesis-1' });
    });

    it('deep copies sections and questions in transaction', async () => {
      prisma.trainer.findUnique.mockResolvedValue(makeTrainer());
      const source = makeAnamnesis({ version: 1 });
      const sourceSection = makeSection();
      const sourceQuestion = makeQuestion({ options: [{ id: 'opt-1', text: 'Yes', order: 0 }] });
      const sourceWithContent = {
        ...source,
        sections: [{ ...sourceSection, questions: [sourceQuestion] }],
      };

      prisma.anamnesis.findUnique
        .mockResolvedValueOnce(source)
        .mockResolvedValueOnce(sourceWithContent);

      const forkedAnamnesis = makeAnamnesis({ id: 'forked-1', version: 2, parentId: 'anamnesis-1', sections: [] });

      const txAnamnesis = { create: vi.fn().mockResolvedValue({ id: 'forked-1' }), findUnique: vi.fn().mockResolvedValue(forkedAnamnesis) };
      const txSection = { create: vi.fn().mockResolvedValue({ id: 'new-section-1' }) };
      const txQuestion = { create: vi.fn().mockResolvedValue({ id: 'new-question-1' }) };
      const txOption = { createMany: vi.fn().mockResolvedValue({ count: 1 }) };

      prisma.$transaction.mockImplementation(async (fn) => fn({
        anamnesis: txAnamnesis,
        anamnesisSection: txSection,
        anamnesisQuestion: txQuestion,
        anamnesisQuestionOption: txOption,
      }));

      await forkAnamnesis('user-1', 'anamnesis-1');

      expect(txSection.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ anamnesisId: 'forked-1' }) }),
      );
      expect(txQuestion.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ sectionId: 'new-section-1' }) }),
      );
      expect(txOption.createMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.arrayContaining([expect.objectContaining({ questionId: 'new-question-1' })]),
        }),
      );
    });
  });

  // ── copyAnamnesis ────────────────────────────────────────────────────────

  describe('copyAnamnesis', () => {
    it('throws 404 when trainer profile does not exist', async () => {
      prisma.trainer.findUnique.mockResolvedValue(null);

      await expect(copyAnamnesis('user-1', 'anamnesis-1')).rejects.toMatchObject({
        httpStatus: 404,
        messageCode: 'trainer.notFound',
      });
    });

    it('throws 404 when anamnesis does not exist', async () => {
      prisma.trainer.findUnique.mockResolvedValue(makeTrainer());
      prisma.anamnesis.findUnique.mockResolvedValue(null);

      await expect(copyAnamnesis('user-1', 'anamnesis-1')).rejects.toMatchObject({
        httpStatus: 404,
        messageCode: 'anamnesis.notFound',
      });
    });

    it("throws 403 when copying another trainer's private anamnesis", async () => {
      prisma.trainer.findUnique.mockResolvedValue(makeTrainer({ id: 'trainer-2' }));
      prisma.anamnesis.findUnique.mockResolvedValue(makeAnamnesis({ trainerId: 'trainer-1' }));

      await expect(copyAnamnesis('user-2', 'anamnesis-1')).rejects.toMatchObject({
        httpStatus: 403,
        messageCode: 'anamnesis.forbidden.notOwner',
      });
    });

    it('allows copying a public anamnesis regardless of trainer ownership', async () => {
      prisma.trainer.findUnique.mockResolvedValue(makeTrainer({ id: 'trainer-2' }));
      const publicAnamnesis = makeAnamnesis({ trainerId: null, isGeneral: true });
      const sourceWithContent = { ...publicAnamnesis, sections: [] };
      prisma.anamnesis.findUnique
        .mockResolvedValueOnce(publicAnamnesis) // findAnamnesisOrThrow
        .mockResolvedValueOnce(sourceWithContent); // load with sections

      const copiedAnamnesis = makeAnamnesis({
        id: 'copy-1',
        trainerId: 'trainer-2',
        isGeneral: false,
        version: 1,
        parentId: null,
        sections: [],
      });

      prisma.$transaction.mockImplementation(async (fn) => {
        const tx = {
          anamnesis: {
            create: vi.fn().mockResolvedValue({ id: 'copy-1' }),
            findUnique: vi.fn().mockResolvedValue(copiedAnamnesis),
          },
          anamnesisSection: { create: vi.fn() },
          anamnesisQuestion: { create: vi.fn() },
          anamnesisQuestionOption: { createMany: vi.fn() },
        };
        return fn(tx);
      });

      const result = await copyAnamnesis('user-2', 'anamnesis-1');

      expect(result).toMatchObject({
        id: 'copy-1',
        trainerId: 'trainer-2',
        isGeneral: false,
        version: 1,
        parentId: null,
      });
    });

    it('allows copying own private anamnesis', async () => {
      prisma.trainer.findUnique.mockResolvedValue(makeTrainer());
      const source = makeAnamnesis({ version: 3 });
      const sourceWithContent = { ...source, sections: [] };
      prisma.anamnesis.findUnique
        .mockResolvedValueOnce(source)
        .mockResolvedValueOnce(sourceWithContent);

      const copiedAnamnesis = makeAnamnesis({
        id: 'copy-1',
        trainerId: 'trainer-1',
        isGeneral: false,
        version: 1,
        parentId: null,
        sections: [],
      });

      prisma.$transaction.mockImplementation(async (fn) => {
        const tx = {
          anamnesis: {
            create: vi.fn().mockResolvedValue({ id: 'copy-1' }),
            findUnique: vi.fn().mockResolvedValue(copiedAnamnesis),
          },
          anamnesisSection: { create: vi.fn() },
          anamnesisQuestion: { create: vi.fn() },
          anamnesisQuestionOption: { createMany: vi.fn() },
        };
        return fn(tx);
      });

      const result = await copyAnamnesis('user-1', 'anamnesis-1');

      expect(result).toMatchObject({ version: 1, parentId: null, isGeneral: false });
    });

    it('creates copy with version: 1 and parentId: null regardless of source version', async () => {
      prisma.trainer.findUnique.mockResolvedValue(makeTrainer());
      const source = makeAnamnesis({ version: 5 });
      const sourceWithContent = { ...source, sections: [] };
      prisma.anamnesis.findUnique
        .mockResolvedValueOnce(source)
        .mockResolvedValueOnce(sourceWithContent);

      let capturedCreateData;
      const copiedAnamnesis = makeAnamnesis({ id: 'copy-1', version: 1, parentId: null, sections: [] });

      prisma.$transaction.mockImplementation(async (fn) => {
        const txCreate = vi.fn().mockImplementation((args) => {
          capturedCreateData = args.data;
          return Promise.resolve({ id: 'copy-1' });
        });
        const tx = {
          anamnesis: {
            create: txCreate,
            findUnique: vi.fn().mockResolvedValue(copiedAnamnesis),
          },
          anamnesisSection: { create: vi.fn() },
          anamnesisQuestion: { create: vi.fn() },
          anamnesisQuestionOption: { createMany: vi.fn() },
        };
        return fn(tx);
      });

      await copyAnamnesis('user-1', 'anamnesis-1');

      expect(capturedCreateData).toMatchObject({
        version: 1,
        parentId: null,
        isGeneral: false,
        trainerId: 'trainer-1',
      });
    });

    it('deep copies sections, questions, and options in transaction', async () => {
      prisma.trainer.findUnique.mockResolvedValue(makeTrainer());
      const source = makeAnamnesis({ version: 1 });
      const sourceSection = makeSection();
      const sourceQuestion = makeQuestion({ options: [{ id: 'opt-1', text: 'Yes', order: 0 }] });
      const sourceWithContent = {
        ...source,
        sections: [{ ...sourceSection, questions: [sourceQuestion] }],
      };

      prisma.anamnesis.findUnique
        .mockResolvedValueOnce(source)
        .mockResolvedValueOnce(sourceWithContent);

      const copiedAnamnesis = makeAnamnesis({ id: 'copy-1', version: 1, parentId: null, sections: [] });

      const txAnamnesis = {
        create: vi.fn().mockResolvedValue({ id: 'copy-1' }),
        findUnique: vi.fn().mockResolvedValue(copiedAnamnesis),
      };
      const txSection = { create: vi.fn().mockResolvedValue({ id: 'new-section-1' }) };
      const txQuestion = { create: vi.fn().mockResolvedValue({ id: 'new-question-1' }) };
      const txOption = { createMany: vi.fn().mockResolvedValue({ count: 1 }) };

      prisma.$transaction.mockImplementation(async (fn) => fn({
        anamnesis: txAnamnesis,
        anamnesisSection: txSection,
        anamnesisQuestion: txQuestion,
        anamnesisQuestionOption: txOption,
      }));

      await copyAnamnesis('user-1', 'anamnesis-1');

      expect(txSection.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ anamnesisId: 'copy-1' }) }),
      );
      expect(txQuestion.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ sectionId: 'new-section-1' }) }),
      );
      expect(txOption.createMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.arrayContaining([expect.objectContaining({ questionId: 'new-question-1' })]),
        }),
      );
    });
  });

  // ── submitAnamnesisResponse ──────────────────────────────────────────────

  describe('submitAnamnesisResponse', () => {
    const makeAnamnesisWithQuestion = (required = false) => ({
      ...makeAnamnesis(),
      sections: [
        {
          ...makeSection(),
          questions: [makeQuestion({ id: 'question-1', required })],
        },
      ],
    });

    const makeAnamnesisResponse = (overrides = {}) => ({
      id: 'response-1',
      anamnesisId: 'anamnesis-1',
      studentId: 'student-1',
      submittedAt: new Date(),
      createdAt: new Date(),
      updatedAt: null,
      answers: [],
      ...overrides,
    });

    it('throws 404 when anamnesis is not linked to student', async () => {
      prisma.studentAnamnesis.findFirst.mockResolvedValue(null);

      await expect(
        submitAnamnesisResponse('student-1', 'anamnesis-1', { answers: [] }),
      ).rejects.toMatchObject({
        httpStatus: 404,
        messageCode: 'anamnesis.notLinkedToStudent',
      });
    });

    it('throws 400 when a required question is not answered', async () => {
      prisma.studentAnamnesis.findFirst.mockResolvedValue({ id: 'link-1' });
      prisma.anamnesis.findUnique.mockResolvedValue(makeAnamnesisWithQuestion(true));

      await expect(
        submitAnamnesisResponse('student-1', 'anamnesis-1', { answers: [] }),
      ).rejects.toMatchObject({
        httpStatus: 400,
        error: 'VALIDATION_ERROR',
        messageCode: 'validation.failed',
      });
    });

    it('throws 404 for unknown questionId in answers', async () => {
      prisma.studentAnamnesis.findFirst.mockResolvedValue({ id: 'link-1' });
      prisma.anamnesis.findUnique.mockResolvedValue(makeAnamnesisWithQuestion(false));

      await expect(
        submitAnamnesisResponse('student-1', 'anamnesis-1', {
          answers: [{ questionId: 'unknown-question-id', value: 'yes' }],
        }),
      ).rejects.toMatchObject({
        httpStatus: 404,
        messageCode: 'anamnesis.question.notFound',
      });
    });

    it('upserts response and replaces answers in transaction', async () => {
      prisma.studentAnamnesis.findFirst.mockResolvedValue({ id: 'link-1' });
      prisma.anamnesis.findUnique.mockResolvedValue(makeAnamnesisWithQuestion(false));

      const response = makeAnamnesisResponse({ answers: [{ id: 'ans-1', questionId: 'question-1', value: 'yes' }] });

      prisma.$transaction.mockImplementation(async (fn) => {
        const tx = {
          anamnesisResponse: {
            upsert: vi.fn().mockResolvedValue({ id: 'response-1' }),
            findUnique: vi.fn().mockResolvedValue(response),
          },
          anamnesisAnswer: {
            deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
            createMany: vi.fn().mockResolvedValue({ count: 1 }),
          },
        };
        return fn(tx);
      });

      const result = await submitAnamnesisResponse('student-1', 'anamnesis-1', {
        answers: [{ questionId: 'question-1', value: 'yes' }],
      });

      expect(result).toMatchObject({ id: 'response-1' });
      expect(prisma.$transaction).toHaveBeenCalled();
    });
  });

  // ── getMyAnamnesisResponse ───────────────────────────────────────────────

  describe('getMyAnamnesisResponse', () => {
    it('throws 404 when anamnesis is not linked to student', async () => {
      prisma.studentAnamnesis.findFirst.mockResolvedValue(null);

      await expect(getMyAnamnesisResponse('student-1', 'anamnesis-1')).rejects.toMatchObject({
        httpStatus: 404,
        messageCode: 'anamnesis.notLinkedToStudent',
      });
    });

    it('throws 404 when no response has been submitted yet', async () => {
      prisma.studentAnamnesis.findFirst.mockResolvedValue({ id: 'link-1' });
      prisma.anamnesisResponse.findUnique.mockResolvedValue(null);

      await expect(getMyAnamnesisResponse('student-1', 'anamnesis-1')).rejects.toMatchObject({
        httpStatus: 404,
        messageCode: 'anamnesis.response.notFound',
      });
    });

    it('returns response with answers', async () => {
      prisma.studentAnamnesis.findFirst.mockResolvedValue({ id: 'link-1' });
      const response = {
        id: 'response-1',
        anamnesisId: 'anamnesis-1',
        studentId: 'student-1',
        submittedAt: new Date(),
        answers: [{ id: 'ans-1', questionId: 'question-1', value: 'yes' }],
      };
      prisma.anamnesisResponse.findUnique.mockResolvedValue(response);

      const result = await getMyAnamnesisResponse('student-1', 'anamnesis-1');

      expect(result).toEqual(response);
      expect(prisma.anamnesisResponse.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { anamnesisId_studentId: { anamnesisId: 'anamnesis-1', studentId: 'student-1' } },
        }),
      );
    });
  });

  // ── getStudentAnamnesisResponse ──────────────────────────────────────────

  describe('getStudentAnamnesisResponse', () => {
    it('throws 404 when trainer-student link is missing', async () => {
      prisma.trainer.findUnique.mockResolvedValue(makeTrainer());
      prisma.trainerStudent.findUnique.mockResolvedValue(null);

      await expect(
        getStudentAnamnesisResponse('user-1', 'student-1', 'anamnesis-1'),
      ).rejects.toMatchObject({
        httpStatus: 404,
        messageCode: 'student.notFound',
      });
    });

    it('throws 404 when anamnesis is not linked to this student by this trainer', async () => {
      prisma.trainer.findUnique.mockResolvedValue(makeTrainer());
      prisma.trainerStudent.findUnique.mockResolvedValue({ trainerId: 'trainer-1', studentId: 'student-1' });
      prisma.studentAnamnesis.findFirst.mockResolvedValue(null);

      await expect(
        getStudentAnamnesisResponse('user-1', 'student-1', 'anamnesis-1'),
      ).rejects.toMatchObject({
        httpStatus: 404,
        messageCode: 'anamnesis.notLinkedToStudent',
      });
    });

    it('throws 404 when student has not submitted a response', async () => {
      prisma.trainer.findUnique.mockResolvedValue(makeTrainer());
      prisma.trainerStudent.findUnique.mockResolvedValue({ trainerId: 'trainer-1', studentId: 'student-1' });
      prisma.studentAnamnesis.findFirst.mockResolvedValue({ id: 'link-1' });
      prisma.anamnesisResponse.findUnique.mockResolvedValue(null);

      await expect(
        getStudentAnamnesisResponse('user-1', 'student-1', 'anamnesis-1'),
      ).rejects.toMatchObject({
        httpStatus: 404,
        messageCode: 'anamnesis.response.notFound',
      });
    });

    it('returns response when all conditions are met', async () => {
      prisma.trainer.findUnique.mockResolvedValue(makeTrainer());
      prisma.trainerStudent.findUnique.mockResolvedValue({ trainerId: 'trainer-1', studentId: 'student-1' });
      prisma.studentAnamnesis.findFirst.mockResolvedValue({ id: 'link-1' });
      const response = {
        id: 'response-1',
        anamnesisId: 'anamnesis-1',
        studentId: 'student-1',
        submittedAt: new Date(),
        answers: [],
      };
      prisma.anamnesisResponse.findUnique.mockResolvedValue(response);

      const result = await getStudentAnamnesisResponse('user-1', 'student-1', 'anamnesis-1');

      expect(result).toEqual(response);
    });
  });
});
