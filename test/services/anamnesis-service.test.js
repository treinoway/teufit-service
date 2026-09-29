import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock platform-plan-service — gating is tested separately
vi.mock('../../src/services/platform-plan-service.js', () => ({
  assertStudentActiveOnPlan: vi.fn().mockResolvedValue(undefined),
}));

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
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      count: vi.fn(),
    },
    anamnesisQuestionOption: { deleteMany: vi.fn(), createMany: vi.fn(), findMany: vi.fn() },
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
      findFirst: vi.fn(),
      findMany: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
    },
    anamnesisAnswer: {
      deleteMany: vi.fn(),
      createMany: vi.fn(),
      upsert: vi.fn(),
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
  saveAnamnesisResponseDraft,
  getMyAnamnesisResponse,
  getStudentAnamnesisResponse,
} from '../../src/services/anamnesis-service.js';
import {
  AnamnesisQuestionType,
  AnamnesisResponseStatus,
  ANAMNESIS_DRAFT_MAX_ANSWERS,
  toResponseStatus,
  validateCondition,
  isQuestionVisible,
} from '../../src/constants/anamnesis.js';
import { validateParentLink, normalizeChoiceAnswersForVisibility } from '../../src/services/anamnesis-shared.js';
import { assertStudentActiveOnPlan } from '../../src/services/platform-plan-service.js';

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
  parentQuestionId: null,
  condition: null,
  createdAt: new Date(),
  updatedAt: null,
  ...overrides,
});

const makeOption = (overrides = {}) => ({
  id: 'opt-1',
  questionId: 'question-1',
  text: 'Option A',
  order: 0,
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
    // Re-apply platform-plan-service mocks after mockReset (mockReset: true in vitest config).
    assertStudentActiveOnPlan.mockResolvedValue(undefined);
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
          $queryRaw: vi.fn().mockResolvedValue([]),
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

    it('lock fires on anamnesis row before first section/question write', async () => {
      prisma.trainer.findUnique.mockResolvedValue(makeTrainer());
      prisma.anamnesis.findUnique.mockResolvedValue(makeAnamnesis());
      prisma.studentAnamnesis.count.mockResolvedValue(0);

      const txMock = {
        $queryRaw: vi.fn().mockResolvedValue([]),
        anamnesisSection: { findMany: vi.fn().mockResolvedValue([]) },
        anamnesisQuestion: { updateMany: vi.fn() },
        anamnesis: { update: vi.fn().mockResolvedValue(makeAnamnesis({ deletedAt: new Date() })) },
      };
      prisma.$transaction.mockImplementation(async (fn) => fn(txMock));

      await deleteAnamnesis('user-1', 'anamnesis-1');

      expect(txMock.$queryRaw).toHaveBeenCalledOnce();
      expect(txMock.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        txMock.anamnesis.update.mock.invocationCallOrder[0],
      );
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
          $queryRaw: vi.fn().mockResolvedValue([]),
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

    it('lock fires on anamnesis row before question and section writes', async () => {
      prisma.trainer.findUnique.mockResolvedValue(makeTrainer());
      prisma.anamnesis.findUnique.mockResolvedValue(makeAnamnesis());
      prisma.anamnesisSection.findUnique.mockResolvedValue(makeSection());
      prisma.studentAnamnesis.count.mockResolvedValue(0);

      const txMock = {
        $queryRaw: vi.fn().mockResolvedValue([]),
        anamnesisQuestion: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
        anamnesisSection: { update: vi.fn().mockResolvedValue(makeSection({ deletedAt: new Date() })) },
      };
      prisma.$transaction.mockImplementation(async (fn) => fn(txMock));

      await deleteSection('user-1', 'anamnesis-1', 'section-1');

      expect(txMock.$queryRaw).toHaveBeenCalledOnce();
      expect(txMock.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        txMock.anamnesisQuestion.updateMany.mock.invocationCallOrder[0],
      );
    });
  });

  // ── reorderSections ──────────────────────────────────────────────────────

  describe('reorderSections', () => {
    it('updates order for each section id in the array', async () => {
      prisma.trainer.findUnique.mockResolvedValue(makeTrainer());
      prisma.anamnesis.findUnique.mockResolvedValue(makeAnamnesis());

      const orderedIds = ['section-2', 'section-1'];

      const txUpdate = vi.fn().mockResolvedValue(makeSection());
      prisma.$transaction.mockImplementation(async (fn) => {
        const tx = {
          $queryRaw: vi.fn().mockResolvedValue([]),
          anamnesisSection: { update: txUpdate },
        };
        return fn(tx);
      });

      prisma.anamnesisSection.findMany.mockResolvedValue([makeSection(), makeSection({ id: 'section-2', order: 1 })]);

      const result = await reorderSections('user-1', 'anamnesis-1', orderedIds);

      expect(txUpdate).toHaveBeenCalledTimes(2);
      expect(txUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'section-2' }, data: { order: 0 } }),
      );
      expect(txUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'section-1' }, data: { order: 1 } }),
      );
      expect(result).toHaveLength(2);
    });

    it('lock fires before first update and updates applied in id-sorted order', async () => {
      prisma.trainer.findUnique.mockResolvedValue(makeTrainer());
      prisma.anamnesis.findUnique.mockResolvedValue(makeAnamnesis());

      // Input order: zzz < aaa < mmm (non-alphabetical)
      const orderedIds = ['zzz-sec', 'aaa-sec', 'mmm-sec'];

      const updateCalls = [];
      const txMock = {
        $queryRaw: vi.fn().mockResolvedValue([]),
        anamnesisSection: {
          update: vi.fn().mockImplementation(async (args) => {
            updateCalls.push(args.where.id);
            return makeSection({ id: args.where.id });
          }),
        },
      };
      prisma.$transaction.mockImplementation(async (fn) => fn(txMock));

      prisma.anamnesisSection.findMany.mockResolvedValue([
        makeSection({ id: 'zzz-sec', order: 0 }),
        makeSection({ id: 'aaa-sec', order: 1 }),
        makeSection({ id: 'mmm-sec', order: 2 }),
      ]);

      await reorderSections('user-1', 'anamnesis-1', orderedIds);

      // Lock must fire before first update
      expect(txMock.$queryRaw).toHaveBeenCalledOnce();
      expect(txMock.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        txMock.anamnesisSection.update.mock.invocationCallOrder[0],
      );

      // Updates applied in ascending UUID sort order
      expect(updateCalls).toEqual(['aaa-sec', 'mmm-sec', 'zzz-sec']);

      // Order values follow the INPUT array positions: zzz→0, aaa→1, mmm→2
      expect(txMock.anamnesisSection.update).toHaveBeenCalledWith({ where: { id: 'zzz-sec' }, data: { order: 0 } });
      expect(txMock.anamnesisSection.update).toHaveBeenCalledWith({ where: { id: 'aaa-sec' }, data: { order: 1 } });
      expect(txMock.anamnesisSection.update).toHaveBeenCalledWith({ where: { id: 'mmm-sec' }, data: { order: 2 } });
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
      // No dependent children — option removal guard passes
      prisma.anamnesisQuestion.findMany.mockResolvedValue([]);

      const updatedQuestion = makeQuestion({ text: 'Updated?' });
      prisma.$transaction.mockImplementation(async (fn) => {
        const tx = {
          anamnesisQuestionOption: {
            deleteMany: vi.fn().mockResolvedValue({ count: 2 }),
            createMany: vi.fn().mockResolvedValue({ count: 1 }),
          },
          anamnesisQuestion: {
            update: vi.fn().mockResolvedValue({ ...updatedQuestion, options: [], dependentQuestions: [] }),
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
      // validateQuestionType throws before count is called, but mock it anyway
      prisma.anamnesisQuestion.count.mockResolvedValue(0);

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
    const makeLinkWithAnamnesis = (anamnesisId, overrides = {}) => ({
      ...makeStudentAnamnesisLink({ id: `link-${anamnesisId}`, anamnesisId }),
      anamnesis: { id: anamnesisId, title: 'Health Questionnaire', sections: [] },
      trainer: { id: 'trainer-1', user: { firstName: 'John', lastName: 'Doe', avatarUrl: null } },
      ...overrides,
    });

    const makeResponseSummaryRow = (anamnesisId, overrides = {}) => ({
      anamnesisId,
      submittedAt: null,
      updatedAt: new Date('2026-03-10T12:00:00.000Z'),
      _count: { answers: 0 },
      ...overrides,
    });

    it('returns all anamneses linked to the student with a null response when nothing was saved', async () => {
      const links = [makeLinkWithAnamnesis('anamnesis-1')];
      prisma.studentAnamnesis.findMany.mockResolvedValue(links);
      prisma.anamnesisResponse.findMany.mockResolvedValue([]);

      const result = await getMyAnamneses('student-1');

      expect(result).toEqual([{ ...links[0], response: null }]);
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

    it('skips the response query when the student has no links', async () => {
      prisma.studentAnamnesis.findMany.mockResolvedValue([]);

      await getMyAnamneses('student-1');

      expect(prisma.anamnesisResponse.findMany).not.toHaveBeenCalled();
    });

    it('issues a single response query for all links (no N+1)', async () => {
      prisma.studentAnamnesis.findMany.mockResolvedValue([
        makeLinkWithAnamnesis('anamnesis-1'),
        makeLinkWithAnamnesis('anamnesis-2'),
        makeLinkWithAnamnesis('anamnesis-3'),
      ]);
      prisma.anamnesisResponse.findMany.mockResolvedValue([]);

      await getMyAnamneses('student-1');

      expect(prisma.anamnesisResponse.findMany).toHaveBeenCalledTimes(1);
    });

    it('scopes the response query to the student, the linked anamnesis ids and a minimal select', async () => {
      prisma.studentAnamnesis.findMany.mockResolvedValue([
        makeLinkWithAnamnesis('anamnesis-1'),
        makeLinkWithAnamnesis('anamnesis-2'),
      ]);
      prisma.anamnesisResponse.findMany.mockResolvedValue([]);

      await getMyAnamneses('student-1');

      expect(prisma.anamnesisResponse.findMany).toHaveBeenCalledWith({
        where: { studentId: 'student-1', anamnesisId: { in: ['anamnesis-1', 'anamnesis-2'] } },
        select: {
          anamnesisId: true,
          submittedAt: true,
          updatedAt: true,
          _count: { select: { answers: true } },
        },
      });
    });

    it('maps a response without submittedAt to status draft with answeredCount and updatedAt', async () => {
      const updatedAt = new Date('2026-03-10T12:00:00.000Z');
      prisma.studentAnamnesis.findMany.mockResolvedValue([makeLinkWithAnamnesis('anamnesis-1')]);
      prisma.anamnesisResponse.findMany.mockResolvedValue([
        makeResponseSummaryRow('anamnesis-1', { submittedAt: null, updatedAt, _count: { answers: 4 } }),
      ]);

      const [result] = await getMyAnamneses('student-1');

      expect(result.response).toEqual({
        status: AnamnesisResponseStatus.DRAFT,
        answeredCount: 4,
        updatedAt,
      });
    });

    it('maps a response with submittedAt to status submitted', async () => {
      const updatedAt = new Date('2026-03-11T08:30:00.000Z');
      prisma.studentAnamnesis.findMany.mockResolvedValue([makeLinkWithAnamnesis('anamnesis-1')]);
      prisma.anamnesisResponse.findMany.mockResolvedValue([
        makeResponseSummaryRow('anamnesis-1', {
          submittedAt: new Date('2026-03-11T08:30:00.000Z'),
          updatedAt,
          _count: { answers: 7 },
        }),
      ]);

      const [result] = await getMyAnamneses('student-1');

      expect(result.response).toEqual({
        status: AnamnesisResponseStatus.SUBMITTED,
        answeredCount: 7,
        updatedAt,
      });
    });

    it('reports answeredCount 0 for a draft with no stored answers', async () => {
      prisma.studentAnamnesis.findMany.mockResolvedValue([makeLinkWithAnamnesis('anamnesis-1')]);
      prisma.anamnesisResponse.findMany.mockResolvedValue([
        makeResponseSummaryRow('anamnesis-1', { _count: { answers: 0 } }),
      ]);

      const [result] = await getMyAnamneses('student-1');

      expect(result.response).toMatchObject({ status: AnamnesisResponseStatus.DRAFT, answeredCount: 0 });
    });

    it('matches each response to its own link and returns null for links without a response', async () => {
      prisma.studentAnamnesis.findMany.mockResolvedValue([
        makeLinkWithAnamnesis('anamnesis-1'),
        makeLinkWithAnamnesis('anamnesis-2'),
        makeLinkWithAnamnesis('anamnesis-3'),
      ]);
      // Response rows come back in a different order than the links
      prisma.anamnesisResponse.findMany.mockResolvedValue([
        makeResponseSummaryRow('anamnesis-3', { submittedAt: new Date(), _count: { answers: 2 } }),
        makeResponseSummaryRow('anamnesis-1', { submittedAt: null, _count: { answers: 5 } }),
      ]);

      const result = await getMyAnamneses('student-1');

      expect(result.map((item) => [item.anamnesisId, item.response?.status ?? null])).toEqual([
        ['anamnesis-1', AnamnesisResponseStatus.DRAFT],
        ['anamnesis-2', null],
        ['anamnesis-3', AnamnesisResponseStatus.SUBMITTED],
      ]);
      expect(result[0].response.answeredCount).toBe(5);
      expect(result[1].response).toBeNull();
      expect(result[2].response.answeredCount).toBe(2);
    });

    it('preserves the original link fields alongside the response summary', async () => {
      const link = makeLinkWithAnamnesis('anamnesis-1');
      prisma.studentAnamnesis.findMany.mockResolvedValue([link]);
      prisma.anamnesisResponse.findMany.mockResolvedValue([makeResponseSummaryRow('anamnesis-1')]);

      const [result] = await getMyAnamneses('student-1');

      expect(result).toMatchObject({ id: link.id, anamnesis: link.anamnesis, trainer: link.trainer });
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
          anamnesisQuestion: { create: vi.fn(), update: vi.fn() },
          anamnesisQuestionOption: { create: vi.fn() },
        };
        return fn(tx);
      });

      const result = await forkAnamnesis('user-1', 'anamnesis-1');

      expect(result).toMatchObject({ id: 'forked-1', version: 2, parentId: 'anamnesis-1' });
    });

    it('deep copies sections, questions, and options in transaction using individual creates', async () => {
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
      const txQuestion = { create: vi.fn().mockResolvedValue({ id: 'new-question-1' }), update: vi.fn() };
      const txOption = { create: vi.fn().mockResolvedValue({ id: 'new-opt-1' }) };

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
      // Individual option creates (not createMany)
      expect(txOption.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ questionId: 'new-question-1', text: 'Yes' }),
        }),
      );
    });

    it('second pass remaps parentQuestionId and condition option IDs for conditional questions', async () => {
      prisma.trainer.findUnique.mockResolvedValue(makeTrainer());
      const source = makeAnamnesis({ version: 1 });
      const sourceSection = makeSection();
      const parentQuestion = makeQuestion({
        id: 'parent-q',
        type: AnamnesisQuestionType.DICHOTOMOUS,
        options: [],
        parentQuestionId: null,
        condition: null,
      });
      const childQuestion = makeQuestion({
        id: 'child-q',
        type: AnamnesisQuestionType.FREE_TEXT,
        options: [],
        parentQuestionId: 'parent-q',
        condition: { operator: 'equals', value: 'yes' },
      });
      const sourceWithContent = {
        ...source,
        sections: [{ ...sourceSection, questions: [parentQuestion, childQuestion] }],
      };

      prisma.anamnesis.findUnique
        .mockResolvedValueOnce(source)
        .mockResolvedValueOnce(sourceWithContent);

      const forkedAnamnesis = makeAnamnesis({ id: 'forked-1', version: 2, parentId: 'anamnesis-1', sections: [] });

      let questionCreateCount = 0;
      const txQuestion = {
        create: vi.fn().mockImplementation(() => {
          questionCreateCount++;
          return Promise.resolve({ id: `new-question-${questionCreateCount}` });
        }),
        update: vi.fn().mockResolvedValue({}),
      };

      prisma.$transaction.mockImplementation(async (fn) => fn({
        anamnesis: { create: vi.fn().mockResolvedValue({ id: 'forked-1' }), findUnique: vi.fn().mockResolvedValue(forkedAnamnesis) },
        anamnesisSection: { create: vi.fn().mockResolvedValue({ id: 'new-section-1' }) },
        anamnesisQuestion: txQuestion,
        anamnesisQuestionOption: { create: vi.fn() },
      }));

      await forkAnamnesis('user-1', 'anamnesis-1');

      // Second pass must have called update for the child question with remapped parentQuestionId
      expect(txQuestion.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'new-question-2' },
          data: expect.objectContaining({
            parentQuestionId: 'new-question-1',
            condition: { operator: 'equals', value: 'yes' },
          }),
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
          anamnesisQuestion: { create: vi.fn(), update: vi.fn() },
          anamnesisQuestionOption: { create: vi.fn() },
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
          anamnesisQuestion: { create: vi.fn(), update: vi.fn() },
          anamnesisQuestionOption: { create: vi.fn() },
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
          anamnesisQuestion: { create: vi.fn(), update: vi.fn() },
          anamnesisQuestionOption: { create: vi.fn() },
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

    it('deep copies sections, questions, and options in transaction using individual creates', async () => {
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
      const txQuestion = { create: vi.fn().mockResolvedValue({ id: 'new-question-1' }), update: vi.fn() };
      const txOption = { create: vi.fn().mockResolvedValue({ id: 'new-opt-1' }) };

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
      // Individual option creates (not createMany)
      expect(txOption.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ questionId: 'new-question-1', text: 'Yes' }),
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

    it('returns status submitted on the finalized response', async () => {
      prisma.studentAnamnesis.findFirst.mockResolvedValue({ id: 'link-1' });
      prisma.anamnesis.findUnique.mockResolvedValue(makeAnamnesisWithQuestion(false));
      prisma.$transaction.mockImplementation(async (fn) =>
        fn({
          anamnesisResponse: {
            upsert: vi.fn().mockResolvedValue({ id: 'response-1' }),
            findUnique: vi.fn().mockResolvedValue(makeAnamnesisResponse()),
          },
          anamnesisAnswer: { deleteMany: vi.fn(), createMany: vi.fn() },
        }),
      );

      const result = await submitAnamnesisResponse('student-1', 'anamnesis-1', {
        answers: [{ questionId: 'question-1', value: 'yes' }],
      });

      expect(result.status).toBe(AnamnesisResponseStatus.SUBMITTED);
    });

    it('marks the response as submitted when converting a previously saved draft', async () => {
      prisma.studentAnamnesis.findFirst.mockResolvedValue({ id: 'link-1' });
      prisma.anamnesis.findUnique.mockResolvedValue(makeAnamnesisWithQuestion(false));
      const upsert = vi.fn().mockResolvedValue({ id: 'response-1' });
      prisma.$transaction.mockImplementation(async (fn) =>
        fn({
          anamnesisResponse: {
            upsert,
            findUnique: vi.fn().mockResolvedValue(makeAnamnesisResponse()),
          },
          anamnesisAnswer: { deleteMany: vi.fn(), createMany: vi.fn() },
        }),
      );

      await submitAnamnesisResponse('student-1', 'anamnesis-1', {
        answers: [{ questionId: 'question-1', value: 'yes' }],
      });

      expect(upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: { submittedAt: expect.any(Date) },
          create: expect.objectContaining({ submittedAt: expect.any(Date) }),
        }),
      );
    });
  });

  // ── saveAnamnesisResponseDraft ───────────────────────────────────────────

  describe('saveAnamnesisResponseDraft', () => {
    const STUDENT_ID = 'student-1';
    const ANAMNESIS_ID = 'anamnesis-1';
    const RESPONSE_ID = 'response-1';

    const makeDraftRow = (overrides = {}) => ({
      id: RESPONSE_ID,
      anamnesisId: ANAMNESIS_ID,
      studentId: STUDENT_ID,
      submittedAt: null,
      createdAt: new Date('2026-03-01T10:00:00.000Z'),
      updatedAt: new Date('2026-03-01T10:00:00.000Z'),
      answers: [],
      ...overrides,
    });

    /**
     * Wires the prisma mock for a draft save: link exists, every payload question is known and the
     * interactive transaction runs against a controllable `tx`.
     */
    const setupDraftSave = ({
      questionIds = ['question-1'],
      upsertedRow = { id: RESPONSE_ID, submittedAt: null },
      lockedRow = { submittedAt: null },
      updatedRow = makeDraftRow(),
    } = {}) => {
      const tx = {
        $queryRaw: vi.fn().mockResolvedValue([]),
        anamnesisResponse: {
          upsert: vi.fn().mockResolvedValue(upsertedRow),
          findUnique: vi.fn().mockResolvedValue(lockedRow),
          update: vi.fn().mockResolvedValue(updatedRow),
        },
        anamnesisAnswer: {
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
          upsert: vi.fn().mockResolvedValue({}),
        },
      };
      prisma.studentAnamnesis.findFirst.mockResolvedValue({ id: 'link-1' });
      prisma.anamnesisQuestion.findMany.mockResolvedValue(questionIds.map((id) => ({ id })));
      prisma.$transaction.mockImplementation(async (fn) => fn(tx));
      return tx;
    };

    const expectNoAnswerWrites = (tx) => {
      expect(tx.anamnesisAnswer.deleteMany).not.toHaveBeenCalled();
      expect(tx.anamnesisAnswer.upsert).not.toHaveBeenCalled();
      expect(tx.anamnesisResponse.update).not.toHaveBeenCalled();
    };

    afterEach(() => {
      vi.useRealTimers();
    });

    describe('link and payload validation', () => {
      it('throws 404 ANAMNESIS_NOT_LINKED_TO_STUDENT when the anamnesis is not linked to the student', async () => {
        prisma.studentAnamnesis.findFirst.mockResolvedValue(null);

        await expect(
          saveAnamnesisResponseDraft(STUDENT_ID, ANAMNESIS_ID, {
            answers: [{ questionId: 'question-1', value: 'yes' }],
          }),
        ).rejects.toMatchObject({
          httpStatus: 404,
          error: 'ANAMNESIS_NOT_LINKED_TO_STUDENT',
          messageCode: 'anamnesis.notLinkedToStudent',
        });
      });

      it('looks up the link by student and anamnesis before anything else', async () => {
        prisma.studentAnamnesis.findFirst.mockResolvedValue(null);

        await expect(
          saveAnamnesisResponseDraft(STUDENT_ID, ANAMNESIS_ID, {
            answers: [{ questionId: 'question-1', value: 'yes' }],
          }),
        ).rejects.toThrow();

        expect(prisma.studentAnamnesis.findFirst).toHaveBeenCalledWith({
          where: { studentId: STUDENT_ID, anamnesisId: ANAMNESIS_ID },
        });
        expect(prisma.anamnesisQuestion.findMany).not.toHaveBeenCalled();
        expect(prisma.$transaction).not.toHaveBeenCalled();
      });

      it('reports not linked (404) rather than the duplicate validation error when both apply', async () => {
        prisma.studentAnamnesis.findFirst.mockResolvedValue(null);

        await expect(
          saveAnamnesisResponseDraft(STUDENT_ID, ANAMNESIS_ID, {
            answers: [
              { questionId: 'question-1', value: 'a' },
              { questionId: 'question-1', value: 'b' },
            ],
          }),
        ).rejects.toMatchObject({ httpStatus: 404, messageCode: 'anamnesis.notLinkedToStudent' });
      });

      it('throws 400 VALIDATION_ERROR with details when a questionId is duplicated in the payload', async () => {
        prisma.studentAnamnesis.findFirst.mockResolvedValue({ id: 'link-1' });

        await expect(
          saveAnamnesisResponseDraft(STUDENT_ID, ANAMNESIS_ID, {
            answers: [
              { questionId: 'question-1', value: 'a' },
              { questionId: 'question-2', value: 'b' },
              { questionId: 'question-1', value: 'c' },
            ],
          }),
        ).rejects.toMatchObject({
          httpStatus: 400,
          error: 'VALIDATION_ERROR',
          messageCode: 'validation.failed',
          details: [{ questionId: 'question-1', message: 'Duplicate questionId in answers' }],
        });
      });

      it('lists every duplicated questionId once in the details', async () => {
        prisma.studentAnamnesis.findFirst.mockResolvedValue({ id: 'link-1' });

        const error = await saveAnamnesisResponseDraft(STUDENT_ID, ANAMNESIS_ID, {
          answers: [
            { questionId: 'question-1', value: 'a' },
            { questionId: 'question-1', value: 'b' },
            { questionId: 'question-1', value: 'c' },
            { questionId: 'question-2', value: 'd' },
            { questionId: 'question-2', value: 'e' },
          ],
        }).catch((e) => e);

        expect(error.details.map((detail) => detail.questionId)).toEqual(['question-1', 'question-2']);
      });

      it('rejects duplicates before touching the question table or opening a transaction', async () => {
        prisma.studentAnamnesis.findFirst.mockResolvedValue({ id: 'link-1' });

        await expect(
          saveAnamnesisResponseDraft(STUDENT_ID, ANAMNESIS_ID, {
            answers: [
              { questionId: 'question-1', value: 'a' },
              { questionId: 'question-1', value: 'b' },
            ],
          }),
        ).rejects.toThrow();

        expect(prisma.anamnesisQuestion.findMany).not.toHaveBeenCalled();
        expect(prisma.$transaction).not.toHaveBeenCalled();
      });

      it('throws 404 ANAMNESIS_QUESTION_NOT_FOUND when a question does not exist in the anamnesis', async () => {
        prisma.studentAnamnesis.findFirst.mockResolvedValue({ id: 'link-1' });
        prisma.anamnesisQuestion.findMany.mockResolvedValue([{ id: 'question-1' }]);

        await expect(
          saveAnamnesisResponseDraft(STUDENT_ID, ANAMNESIS_ID, {
            answers: [
              { questionId: 'question-1', value: 'a' },
              { questionId: 'unknown-question', value: 'b' },
            ],
          }),
        ).rejects.toMatchObject({
          httpStatus: 404,
          error: 'ANAMNESIS_QUESTION_NOT_FOUND',
          messageCode: 'anamnesis.question.notFound',
        });
        expect(prisma.$transaction).not.toHaveBeenCalled();
      });

      it('only accepts non-deleted questions of non-deleted sections of this anamnesis', async () => {
        prisma.studentAnamnesis.findFirst.mockResolvedValue({ id: 'link-1' });
        prisma.anamnesisQuestion.findMany.mockResolvedValue([]);

        await expect(
          saveAnamnesisResponseDraft(STUDENT_ID, ANAMNESIS_ID, {
            answers: [{ questionId: 'question-1', value: 'a' }],
          }),
        ).rejects.toMatchObject({ httpStatus: 404 });

        expect(prisma.anamnesisQuestion.findMany).toHaveBeenCalledWith({
          where: {
            id: { in: ['question-1'] },
            deletedAt: null,
            section: { anamnesisId: ANAMNESIS_ID, deletedAt: null },
          },
          select: { id: true },
        });
      });
    });

    describe('draft persistence', () => {
      it('creates the response as a draft (submittedAt null) without touching an existing one', async () => {
        const tx = setupDraftSave();

        await saveAnamnesisResponseDraft(STUDENT_ID, ANAMNESIS_ID, {
          answers: [{ questionId: 'question-1', value: 'yes' }],
        });

        expect(tx.anamnesisResponse.upsert).toHaveBeenCalledWith({
          where: { anamnesisId_studentId: { anamnesisId: ANAMNESIS_ID, studentId: STUDENT_ID } },
          create: { anamnesisId: ANAMNESIS_ID, studentId: STUDENT_ID, submittedAt: null },
          update: {},
        });
      });

      it('upserts only the answers present in the payload, keyed by responseId_questionId', async () => {
        const tx = setupDraftSave({ questionIds: ['question-1', 'question-2'] });

        await saveAnamnesisResponseDraft(STUDENT_ID, ANAMNESIS_ID, {
          answers: [
            { questionId: 'question-1', value: 'yes' },
            { questionId: 'question-2', value: ['a', 'b'] },
          ],
        });

        expect(tx.anamnesisAnswer.upsert).toHaveBeenCalledTimes(2);
        expect(tx.anamnesisAnswer.upsert).toHaveBeenNthCalledWith(1, {
          where: { responseId_questionId: { responseId: RESPONSE_ID, questionId: 'question-1' } },
          create: { responseId: RESPONSE_ID, questionId: 'question-1', value: 'yes' },
          update: { value: 'yes' },
        });
        expect(tx.anamnesisAnswer.upsert).toHaveBeenNthCalledWith(2, {
          where: { responseId_questionId: { responseId: RESPONSE_ID, questionId: 'question-2' } },
          create: { responseId: RESPONSE_ID, questionId: 'question-2', value: ['a', 'b'] },
          update: { value: ['a', 'b'] },
        });
      });

      it('never wipes answers that are not in the payload (no deleteMany, no createMany)', async () => {
        const tx = setupDraftSave();
        tx.anamnesisAnswer.createMany = vi.fn();

        await saveAnamnesisResponseDraft(STUDENT_ID, ANAMNESIS_ID, {
          answers: [{ questionId: 'question-1', value: 'yes' }],
        });

        expect(tx.anamnesisAnswer.deleteMany).not.toHaveBeenCalled();
        expect(tx.anamnesisAnswer.createMany).not.toHaveBeenCalled();
      });

      it.each([
        ['0', 0],
        ['false', false],
      ])('treats %s as a real answer and upserts it instead of clearing it', async (_label, value) => {
        const tx = setupDraftSave();

        await saveAnamnesisResponseDraft(STUDENT_ID, ANAMNESIS_ID, {
          answers: [{ questionId: 'question-1', value }],
        });

        expect(tx.anamnesisAnswer.upsert).toHaveBeenCalledWith(
          expect.objectContaining({ update: { value } }),
        );
        expect(tx.anamnesisAnswer.deleteMany).not.toHaveBeenCalled();
      });

      it('returns the draft with all stored answers and status draft', async () => {
        const storedAnswers = [
          { id: 'ans-1', responseId: RESPONSE_ID, questionId: 'question-1', value: 'yes' },
          { id: 'ans-2', responseId: RESPONSE_ID, questionId: 'question-9', value: 'kept from earlier save' },
        ];
        setupDraftSave({ updatedRow: makeDraftRow({ answers: storedAnswers }) });

        const result = await saveAnamnesisResponseDraft(STUDENT_ID, ANAMNESIS_ID, {
          answers: [{ questionId: 'question-1', value: 'yes' }],
        });

        expect(result).toMatchObject({
          id: RESPONSE_ID,
          submittedAt: null,
          status: AnamnesisResponseStatus.DRAFT,
          answers: storedAnswers,
        });
      });

      it('bumps updatedAt explicitly and re-reads the answers', async () => {
        vi.useFakeTimers();
        const savedAt = new Date('2026-04-02T09:15:00.000Z');
        vi.setSystemTime(savedAt);
        const tx = setupDraftSave();

        await saveAnamnesisResponseDraft(STUDENT_ID, ANAMNESIS_ID, {
          answers: [{ questionId: 'question-1', value: 'yes' }],
        });

        expect(tx.anamnesisResponse.update).toHaveBeenCalledWith({
          where: { id: RESPONSE_ID },
          data: { updatedAt: savedAt },
          include: { answers: true },
        });
      });

      it('runs the whole write in a single transaction', async () => {
        setupDraftSave();

        await saveAnamnesisResponseDraft(STUDENT_ID, ANAMNESIS_ID, {
          answers: [{ questionId: 'question-1', value: 'yes' }],
        });

        expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      });

      it('uses the injected prisma client instead of the default singleton', async () => {
        const tx = {
          $queryRaw: vi.fn().mockResolvedValue([]),
          anamnesisResponse: {
            upsert: vi.fn().mockResolvedValue({ id: RESPONSE_ID, submittedAt: null }),
            findUnique: vi.fn().mockResolvedValue({ submittedAt: null }),
            update: vi.fn().mockResolvedValue(makeDraftRow()),
          },
          anamnesisAnswer: { deleteMany: vi.fn(), upsert: vi.fn() },
        };
        const customClient = {
          studentAnamnesis: { findFirst: vi.fn().mockResolvedValue({ id: 'link-1' }) },
          anamnesisQuestion: { findMany: vi.fn().mockResolvedValue([{ id: 'question-1' }]) },
          $transaction: vi.fn(async (fn) => fn(tx)),
        };

        const result = await saveAnamnesisResponseDraft(
          STUDENT_ID,
          ANAMNESIS_ID,
          { answers: [{ questionId: 'question-1', value: 'yes' }] },
          customClient,
        );

        expect(result.status).toBe(AnamnesisResponseStatus.DRAFT);
        expect(customClient.$transaction).toHaveBeenCalledTimes(1);
        expect(prisma.$transaction).not.toHaveBeenCalled();
        expect(prisma.studentAnamnesis.findFirst).not.toHaveBeenCalled();
      });
    });

    describe('clearing answers with empty values', () => {
      it.each([
        ['null', null],
        ['undefined', undefined],
        ['an empty string', ''],
        ['a blank string', '   \t '],
        ['an empty array', []],
      ])('deletes the stored answer when the value is %s', async (_label, value) => {
        const tx = setupDraftSave();

        await saveAnamnesisResponseDraft(STUDENT_ID, ANAMNESIS_ID, {
          answers: [{ questionId: 'question-1', value }],
        });

        expect(tx.anamnesisAnswer.deleteMany).toHaveBeenCalledTimes(1);
        expect(tx.anamnesisAnswer.deleteMany).toHaveBeenCalledWith({
          where: { responseId: RESPONSE_ID, questionId: { in: ['question-1'] } },
        });
        expect(tx.anamnesisAnswer.upsert).not.toHaveBeenCalled();
      });

      it('clears all empty answers with ONE deleteMany scoped to those questions only', async () => {
        const tx = setupDraftSave({ questionIds: ['question-1', 'question-2', 'question-3'] });

        await saveAnamnesisResponseDraft(STUDENT_ID, ANAMNESIS_ID, {
          answers: [
            { questionId: 'question-1', value: '' },
            { questionId: 'question-2', value: [] },
            { questionId: 'question-3', value: null },
          ],
        });

        expect(tx.anamnesisAnswer.deleteMany).toHaveBeenCalledTimes(1);
        expect(tx.anamnesisAnswer.deleteMany).toHaveBeenCalledWith({
          where: { responseId: RESPONSE_ID, questionId: { in: ['question-1', 'question-2', 'question-3'] } },
        });
      });

      it('clears the empty answers and upserts the filled ones in the same save', async () => {
        const tx = setupDraftSave({ questionIds: ['question-1', 'question-2', 'question-3'] });

        await saveAnamnesisResponseDraft(STUDENT_ID, ANAMNESIS_ID, {
          answers: [
            { questionId: 'question-1', value: '' },
            { questionId: 'question-2', value: 'new answer' },
            { questionId: 'question-3', value: ['a'] },
          ],
        });

        expect(tx.anamnesisAnswer.deleteMany).toHaveBeenCalledWith({
          where: { responseId: RESPONSE_ID, questionId: { in: ['question-1'] } },
        });
        expect(tx.anamnesisAnswer.upsert.mock.calls.map(([args]) => args.create.questionId)).toEqual([
          'question-2',
          'question-3',
        ]);
      });

      it('does not call deleteMany when every answer has a value', async () => {
        const tx = setupDraftSave();

        await saveAnamnesisResponseDraft(STUDENT_ID, ANAMNESIS_ID, {
          answers: [{ questionId: 'question-1', value: 'yes' }],
        });

        expect(tx.anamnesisAnswer.deleteMany).not.toHaveBeenCalled();
      });
    });

    describe('already submitted responses (409)', () => {
      const alreadySubmittedError = {
        httpStatus: 409,
        error: 'ANAMNESIS_RESPONSE_ALREADY_SUBMITTED',
        messageCode: 'anamnesis.response.alreadySubmitted',
      };

      it('throws 409 when the response is already submitted', async () => {
        const submittedAt = new Date('2026-03-05T10:00:00.000Z');
        const tx = setupDraftSave({
          upsertedRow: { id: RESPONSE_ID, submittedAt },
          lockedRow: { submittedAt },
        });

        await expect(
          saveAnamnesisResponseDraft(STUDENT_ID, ANAMNESIS_ID, {
            answers: [{ questionId: 'question-1', value: 'yes' }],
          }),
        ).rejects.toMatchObject(alreadySubmittedError);
        expectNoAnswerWrites(tx);
      });

      it('throws 409 when the upsert returns a draft-looking row but the re-read after the lock shows it submitted', async () => {
        // Simulates a final POST committing between the upsert and the row lock being granted
        const tx = setupDraftSave({
          upsertedRow: { id: RESPONSE_ID, submittedAt: null },
          lockedRow: { submittedAt: new Date('2026-03-05T10:00:00.000Z') },
        });

        await expect(
          saveAnamnesisResponseDraft(STUDENT_ID, ANAMNESIS_ID, {
            answers: [{ questionId: 'question-1', value: 'yes' }],
          }),
        ).rejects.toMatchObject(alreadySubmittedError);
        expectNoAnswerWrites(tx);
      });

      it('takes the row lock BEFORE re-reading submittedAt, and both BEFORE any answer write', async () => {
        const tx = setupDraftSave({ questionIds: ['question-1', 'question-2'] });

        await saveAnamnesisResponseDraft(STUDENT_ID, ANAMNESIS_ID, {
          answers: [
            { questionId: 'question-1', value: '' },
            { questionId: 'question-2', value: 'yes' },
          ],
        });

        const lockOrder = tx.$queryRaw.mock.invocationCallOrder[0];
        const reReadOrder = tx.anamnesisResponse.findUnique.mock.invocationCallOrder[0];
        const deleteOrder = tx.anamnesisAnswer.deleteMany.mock.invocationCallOrder[0];
        const upsertOrder = tx.anamnesisAnswer.upsert.mock.invocationCallOrder[0];
        const updatedAtOrder = tx.anamnesisResponse.update.mock.invocationCallOrder[0];

        expect(lockOrder).toBeLessThan(reReadOrder);
        expect(reReadOrder).toBeLessThan(deleteOrder);
        expect(reReadOrder).toBeLessThan(upsertOrder);
        expect(upsertOrder).toBeLessThan(updatedAtOrder);
      });

      it('locks the anamnesis_responses row of the upserted response', async () => {
        const tx = setupDraftSave();

        await saveAnamnesisResponseDraft(STUDENT_ID, ANAMNESIS_ID, {
          answers: [{ questionId: 'question-1', value: 'yes' }],
        });

        expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
        const [sqlParts, lockedId] = tx.$queryRaw.mock.calls[0];
        expect(sqlParts.join('?')).toContain('anamnesis_responses');
        expect(sqlParts.join('?')).toContain('FOR UPDATE');
        expect(lockedId).toBe(RESPONSE_ID);
      });

      it('re-reads submittedAt from the locked response by id', async () => {
        const tx = setupDraftSave();

        await saveAnamnesisResponseDraft(STUDENT_ID, ANAMNESIS_ID, {
          answers: [{ questionId: 'question-1', value: 'yes' }],
        });

        expect(tx.anamnesisResponse.findUnique).toHaveBeenCalledWith({
          where: { id: RESPONSE_ID },
          select: { submittedAt: true },
        });
      });

      it('does not retry a 409', async () => {
        setupDraftSave({ lockedRow: { submittedAt: new Date() } });

        await expect(
          saveAnamnesisResponseDraft(STUDENT_ID, ANAMNESIS_ID, {
            answers: [{ questionId: 'question-1', value: 'yes' }],
          }),
        ).rejects.toMatchObject({ httpStatus: 409 });

        expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      });
    });

    describe('draft semantics', () => {
      it('does not validate required questions (never loads the anamnesis definition)', async () => {
        const tx = setupDraftSave();

        const result = await saveAnamnesisResponseDraft(STUDENT_ID, ANAMNESIS_ID, {
          answers: [{ questionId: 'question-1', value: 'partial' }],
        });

        expect(result.status).toBe(AnamnesisResponseStatus.DRAFT);
        expect(prisma.anamnesis.findUnique).not.toHaveBeenCalled();
        expect(tx.anamnesisAnswer.upsert).toHaveBeenCalledTimes(1);
      });

      it('keeps answers of hidden conditional questions instead of pruning them', async () => {
        // child-question depends on a parent that is not even answered in this payload (hidden),
        // yet its answer must be stored — the final submit is what prunes hidden answers.
        const tx = setupDraftSave({ questionIds: ['child-question'] });

        await saveAnamnesisResponseDraft(STUDENT_ID, ANAMNESIS_ID, {
          answers: [{ questionId: 'child-question', value: 'answer while parent is unanswered' }],
        });

        expect(tx.anamnesisAnswer.upsert).toHaveBeenCalledWith(
          expect.objectContaining({
            create: {
              responseId: RESPONSE_ID,
              questionId: 'child-question',
              value: 'answer while parent is unanswered',
            },
          }),
        );
        expect(tx.anamnesisAnswer.deleteMany).not.toHaveBeenCalled();
      });
    });

    describe('unique constraint retry (concurrent first save)', () => {
      const makeUniqueViolation = () => Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
      const payload = { answers: [{ questionId: 'question-1', value: 'yes' }] };

      it('retries once when the transaction fails with P2002 and returns the retried result', async () => {
        const tx = setupDraftSave();
        prisma.$transaction
          .mockRejectedValueOnce(makeUniqueViolation())
          .mockImplementationOnce(async (fn) => fn(tx));

        const result = await saveAnamnesisResponseDraft(STUDENT_ID, ANAMNESIS_ID, payload);

        expect(prisma.$transaction).toHaveBeenCalledTimes(2);
        expect(result).toMatchObject({ id: RESPONSE_ID, status: AnamnesisResponseStatus.DRAFT });
      });

      it('validates the link and questions only once even when the transaction is retried', async () => {
        const tx = setupDraftSave();
        prisma.$transaction
          .mockRejectedValueOnce(makeUniqueViolation())
          .mockImplementationOnce(async (fn) => fn(tx));

        await saveAnamnesisResponseDraft(STUDENT_ID, ANAMNESIS_ID, payload);

        expect(prisma.studentAnamnesis.findFirst).toHaveBeenCalledTimes(1);
        expect(prisma.anamnesisQuestion.findMany).toHaveBeenCalledTimes(1);
      });

      it('propagates a second consecutive P2002 without a third attempt', async () => {
        setupDraftSave();
        const secondViolation = makeUniqueViolation();
        prisma.$transaction
          .mockReset()
          .mockRejectedValueOnce(makeUniqueViolation())
          .mockRejectedValueOnce(secondViolation);

        await expect(saveAnamnesisResponseDraft(STUDENT_ID, ANAMNESIS_ID, payload)).rejects.toBe(secondViolation);

        expect(prisma.$transaction).toHaveBeenCalledTimes(2);
      });

      it('does not retry errors other than P2002', async () => {
        setupDraftSave();
        const otherError = Object.assign(new Error('Deadlock detected'), { code: 'P2034' });
        prisma.$transaction.mockReset().mockRejectedValue(otherError);

        await expect(saveAnamnesisResponseDraft(STUDENT_ID, ANAMNESIS_ID, payload)).rejects.toBe(otherError);

        expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      });

      it('does not retry errors without a code', async () => {
        setupDraftSave();
        const plainError = new Error('connection lost');
        prisma.$transaction.mockReset().mockRejectedValue(plainError);

        await expect(saveAnamnesisResponseDraft(STUDENT_ID, ANAMNESIS_ID, payload)).rejects.toBe(plainError);

        expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      });
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

    it('returns a draft response (submittedAt null) with status draft', async () => {
      prisma.studentAnamnesis.findFirst.mockResolvedValue({ id: 'link-1' });
      const draft = {
        id: 'response-1',
        anamnesisId: 'anamnesis-1',
        studentId: 'student-1',
        submittedAt: null,
        answers: [{ id: 'ans-1', questionId: 'question-1', value: 'yes' }],
      };
      prisma.anamnesisResponse.findUnique.mockResolvedValue(draft);

      const result = await getMyAnamnesisResponse('student-1', 'anamnesis-1');

      expect(result).toEqual({ ...draft, status: AnamnesisResponseStatus.DRAFT });
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

      expect(result).toEqual({ ...response, status: AnamnesisResponseStatus.SUBMITTED });
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
      prisma.anamnesisResponse.findFirst.mockResolvedValue(null);

      await expect(
        getStudentAnamnesisResponse('user-1', 'student-1', 'anamnesis-1'),
      ).rejects.toMatchObject({
        httpStatus: 404,
        error: 'ANAMNESIS_RESPONSE_NOT_FOUND',
        messageCode: 'anamnesis.response.notFound',
      });
    });

    it('throws 404 when only a draft exists, by querying for submitted responses only', async () => {
      prisma.trainer.findUnique.mockResolvedValue(makeTrainer());
      prisma.trainerStudent.findUnique.mockResolvedValue({ trainerId: 'trainer-1', studentId: 'student-1' });
      prisma.studentAnamnesis.findFirst.mockResolvedValue({ id: 'link-1' });
      // The DB filter (submittedAt not null) hides the draft row, so the query yields nothing
      prisma.anamnesisResponse.findFirst.mockResolvedValue(null);

      await expect(
        getStudentAnamnesisResponse('user-1', 'student-1', 'anamnesis-1'),
      ).rejects.toMatchObject({ httpStatus: 404, messageCode: 'anamnesis.response.notFound' });
      expect(prisma.anamnesisResponse.findFirst).toHaveBeenCalledWith({
        where: { anamnesisId: 'anamnesis-1', studentId: 'student-1', submittedAt: { not: null } },
        include: { answers: true },
      });
      expect(prisma.anamnesisResponse.findUnique).not.toHaveBeenCalled();
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
      prisma.anamnesisResponse.findFirst.mockResolvedValue(response);

      const result = await getStudentAnamnesisResponse('user-1', 'student-1', 'anamnesis-1');

      expect(result).toEqual({ ...response, status: AnamnesisResponseStatus.SUBMITTED });
    });
  });

  // ── toResponseStatus (pure, from constants) ──────────────────────────────

  describe('toResponseStatus', () => {
    it('returns submitted when submittedAt is a Date', () => {
      expect(toResponseStatus(new Date('2026-03-05T10:00:00.000Z'))).toBe(AnamnesisResponseStatus.SUBMITTED);
    });

    it.each([
      ['null', null],
      ['undefined', undefined],
    ])('returns draft when submittedAt is %s', (_label, submittedAt) => {
      expect(toResponseStatus(submittedAt)).toBe(AnamnesisResponseStatus.DRAFT);
    });

    it('exposes the stable status values used by clients', () => {
      expect(AnamnesisResponseStatus).toEqual({ DRAFT: 'draft', SUBMITTED: 'submitted' });
    });

    it('caps a draft save at 300 answers', () => {
      expect(ANAMNESIS_DRAFT_MAX_ANSWERS).toBe(300);
    });
  });

  // ── validateCondition (pure, from constants) ─────────────────────────────

  describe('validateCondition', () => {
    const makeParentQuestion = (type, options = []) => ({
      id: 'parent-q',
      type,
      options,
    });

    it('throws PARENT_NOT_ELIGIBLE when parent type is free_text', () => {
      expect(() =>
        validateCondition(
          makeParentQuestion(AnamnesisQuestionType.FREE_TEXT),
          { operator: 'equals', value: 'yes' },
        ),
      ).toThrow(expect.objectContaining({
        error: 'PARENT_NOT_ELIGIBLE',
        messageCode: 'anamnesis.parentNotEligible',
      }));
    });

    it('throws PARENT_NOT_ELIGIBLE when parent type is numeric', () => {
      expect(() =>
        validateCondition(
          makeParentQuestion(AnamnesisQuestionType.NUMERIC),
          { operator: 'equals', value: 'yes' },
        ),
      ).toThrow(expect.objectContaining({ error: 'PARENT_NOT_ELIGIBLE' }));
    });

    it('throws PARENT_NOT_ELIGIBLE when parent type is matrix', () => {
      expect(() =>
        validateCondition(
          makeParentQuestion(AnamnesisQuestionType.MATRIX),
          { operator: 'equals', value: 'yes' },
        ),
      ).toThrow(expect.objectContaining({ error: 'PARENT_NOT_ELIGIBLE' }));
    });

    it('throws INVALID_CONDITION when condition is null', () => {
      expect(() =>
        validateCondition(
          makeParentQuestion(AnamnesisQuestionType.DICHOTOMOUS),
          null,
        ),
      ).toThrow(expect.objectContaining({ error: 'INVALID_CONDITION' }));
    });

    describe('dichotomous parent', () => {
      it('accepts valid condition with value "yes"', () => {
        expect(() =>
          validateCondition(
            makeParentQuestion(AnamnesisQuestionType.DICHOTOMOUS),
            { operator: 'equals', value: 'yes' },
          ),
        ).not.toThrow();
      });

      it('accepts valid condition with value "no"', () => {
        expect(() =>
          validateCondition(
            makeParentQuestion(AnamnesisQuestionType.DICHOTOMOUS),
            { operator: 'equals', value: 'no' },
          ),
        ).not.toThrow();
      });

      it('throws INVALID_CONDITION when operator is not "equals"', () => {
        expect(() =>
          validateCondition(
            makeParentQuestion(AnamnesisQuestionType.DICHOTOMOUS),
            { operator: 'includesAny', value: 'yes' },
          ),
        ).toThrow(expect.objectContaining({ error: 'INVALID_CONDITION' }));
      });

      it('throws INVALID_CONDITION when value is not "yes" or "no"', () => {
        expect(() =>
          validateCondition(
            makeParentQuestion(AnamnesisQuestionType.DICHOTOMOUS),
            { operator: 'equals', value: 'maybe' },
          ),
        ).toThrow(expect.objectContaining({ error: 'INVALID_CONDITION' }));
      });
    });

    describe('single_choice parent', () => {
      const options = [{ id: 'opt-1', text: 'A' }, { id: 'opt-2', text: 'B' }];

      it('accepts valid condition with known optionId', () => {
        expect(() =>
          validateCondition(
            makeParentQuestion(AnamnesisQuestionType.SINGLE_CHOICE, options),
            { operator: 'equals', optionId: 'opt-1' },
          ),
        ).not.toThrow();
      });

      it('throws INVALID_CONDITION when optionId is missing', () => {
        expect(() =>
          validateCondition(
            makeParentQuestion(AnamnesisQuestionType.SINGLE_CHOICE, options),
            { operator: 'equals' },
          ),
        ).toThrow(expect.objectContaining({ error: 'INVALID_CONDITION' }));
      });

      it('throws INVALID_CONDITION when optionId does not belong to parent', () => {
        expect(() =>
          validateCondition(
            makeParentQuestion(AnamnesisQuestionType.SINGLE_CHOICE, options),
            { operator: 'equals', optionId: 'opt-foreign' },
          ),
        ).toThrow(expect.objectContaining({ error: 'INVALID_CONDITION' }));
      });
    });

    describe('multiple_choice parent', () => {
      const options = [{ id: 'opt-1', text: 'A' }, { id: 'opt-2', text: 'B' }];

      it('accepts valid condition with known optionIds', () => {
        expect(() =>
          validateCondition(
            makeParentQuestion(AnamnesisQuestionType.MULTIPLE_CHOICE, options),
            { operator: 'includesAny', optionIds: ['opt-1'] },
          ),
        ).not.toThrow();
      });

      it('throws INVALID_CONDITION when operator is not "includesAny"', () => {
        expect(() =>
          validateCondition(
            makeParentQuestion(AnamnesisQuestionType.MULTIPLE_CHOICE, options),
            { operator: 'equals', optionIds: ['opt-1'] },
          ),
        ).toThrow(expect.objectContaining({ error: 'INVALID_CONDITION' }));
      });

      it('throws INVALID_CONDITION when optionIds is empty', () => {
        expect(() =>
          validateCondition(
            makeParentQuestion(AnamnesisQuestionType.MULTIPLE_CHOICE, options),
            { operator: 'includesAny', optionIds: [] },
          ),
        ).toThrow(expect.objectContaining({ error: 'INVALID_CONDITION' }));
      });

      it('throws INVALID_CONDITION when optionIds contains foreign IDs', () => {
        expect(() =>
          validateCondition(
            makeParentQuestion(AnamnesisQuestionType.MULTIPLE_CHOICE, options),
            { operator: 'includesAny', optionIds: ['opt-1', 'foreign-id'] },
          ),
        ).toThrow(expect.objectContaining({ error: 'INVALID_CONDITION' }));
      });
    });
  });

  // ── isQuestionVisible (pure function) ────────────────────────────────────

  describe('isQuestionVisible', () => {
    it('returns true for unconditional questions (no parentQuestionId)', () => {
      const question = makeQuestion({ parentQuestionId: null, condition: null });
      expect(isQuestionVisible(question, {})).toBe(true);
    });

    it('returns false when parent has not been answered', () => {
      const question = makeQuestion({
        parentQuestionId: 'parent-q',
        condition: { operator: 'equals', value: 'yes' },
      });
      expect(isQuestionVisible(question, {})).toBe(false);
    });

    it('returns false when parent answer is null', () => {
      const question = makeQuestion({
        parentQuestionId: 'parent-q',
        condition: { operator: 'equals', value: 'yes' },
      });
      expect(isQuestionVisible(question, { 'parent-q': null })).toBe(false);
    });

    describe('dichotomous condition (equals + value)', () => {
      const question = makeQuestion({
        parentQuestionId: 'parent-q',
        condition: { operator: 'equals', value: 'yes' },
      });

      it('returns true when parent answer matches', () => {
        expect(isQuestionVisible(question, { 'parent-q': 'yes' })).toBe(true);
      });

      it('returns false when parent answer does not match', () => {
        expect(isQuestionVisible(question, { 'parent-q': 'no' })).toBe(false);
      });
    });

    describe('single_choice condition (equals + optionId)', () => {
      const question = makeQuestion({
        parentQuestionId: 'parent-q',
        condition: { operator: 'equals', optionId: 'opt-1' },
      });

      it('returns true when parent answer matches the optionId', () => {
        expect(isQuestionVisible(question, { 'parent-q': 'opt-1' })).toBe(true);
      });

      it('returns false when parent answer does not match', () => {
        expect(isQuestionVisible(question, { 'parent-q': 'opt-2' })).toBe(false);
      });
    });

    describe('multiple_choice condition (includesAny + optionIds)', () => {
      const question = makeQuestion({
        parentQuestionId: 'parent-q',
        condition: { operator: 'includesAny', optionIds: ['opt-1', 'opt-2'] },
      });

      it('returns true when parent answer includes any of the optionIds', () => {
        expect(isQuestionVisible(question, { 'parent-q': ['opt-2', 'opt-3'] })).toBe(true);
      });

      it('returns false when parent answer includes none of the optionIds', () => {
        expect(isQuestionVisible(question, { 'parent-q': ['opt-3'] })).toBe(false);
      });

      it('returns false when parent answer is not an array', () => {
        expect(isQuestionVisible(question, { 'parent-q': 'opt-1' })).toBe(false);
      });
    });

    it('works with a Map as answersByQuestionId', () => {
      const question = makeQuestion({
        parentQuestionId: 'parent-q',
        condition: { operator: 'equals', value: 'yes' },
      });
      const answersMap = new Map([['parent-q', 'yes']]);
      expect(isQuestionVisible(question, answersMap)).toBe(true);
    });
  });

  // ── validateParentLink (service helper) ─────────────────────────────────

  describe('validateParentLink', () => {
    it('throws 404 when parent question does not exist', async () => {
      prisma.anamnesisQuestion.findUnique.mockResolvedValue(null);

      await expect(
        validateParentLink({ parentId: 'parent-q', childSectionId: 'section-1', condition: { operator: 'equals', value: 'yes' } }, prisma),
      ).rejects.toMatchObject({
        httpStatus: 404,
        messageCode: 'anamnesis.question.notFound',
      });
    });

    it('throws 404 when parent question is soft-deleted', async () => {
      prisma.anamnesisQuestion.findUnique.mockResolvedValue(
        makeQuestion({ id: 'parent-q', deletedAt: new Date() }),
      );

      await expect(
        validateParentLink({ parentId: 'parent-q', childSectionId: 'section-1', condition: { operator: 'equals', value: 'yes' } }, prisma),
      ).rejects.toMatchObject({
        httpStatus: 404,
        messageCode: 'anamnesis.question.notFound',
      });
    });

    it('throws PARENT_MUST_BE_SAME_SECTION when parent is in a different section', async () => {
      prisma.anamnesisQuestion.findUnique.mockResolvedValue(
        makeQuestion({ id: 'parent-q', sectionId: 'other-section', type: AnamnesisQuestionType.DICHOTOMOUS, options: [] }),
      );

      await expect(
        validateParentLink({ parentId: 'parent-q', childSectionId: 'section-1', condition: { operator: 'equals', value: 'yes' } }, prisma),
      ).rejects.toMatchObject({
        httpStatus: 400,
        error: 'PARENT_MUST_BE_SAME_SECTION',
        messageCode: 'anamnesis.parentMustBeSameSection',
      });
    });

    it('throws PARENT_NOT_ELIGIBLE when parent type is free_text', async () => {
      prisma.anamnesisQuestion.findUnique.mockResolvedValue(
        makeQuestion({ id: 'parent-q', sectionId: 'section-1', type: AnamnesisQuestionType.FREE_TEXT, options: [] }),
      );

      await expect(
        validateParentLink({ parentId: 'parent-q', childSectionId: 'section-1', condition: { operator: 'equals', value: 'yes' } }, prisma),
      ).rejects.toMatchObject({
        httpStatus: 400,
        error: 'PARENT_NOT_ELIGIBLE',
        messageCode: 'anamnesis.parentNotEligible',
      });
    });

    it('throws CONDITIONAL_DEPTH_EXCEEDED when parent itself has a parent', async () => {
      prisma.anamnesisQuestion.findUnique.mockResolvedValue(
        makeQuestion({
          id: 'parent-q',
          sectionId: 'section-1',
          type: AnamnesisQuestionType.DICHOTOMOUS,
          options: [],
          parentQuestionId: 'grandparent-q',
        }),
      );

      await expect(
        validateParentLink({ parentId: 'parent-q', childSectionId: 'section-1', condition: { operator: 'equals', value: 'yes' } }, prisma),
      ).rejects.toMatchObject({
        httpStatus: 400,
        error: 'CONDITIONAL_DEPTH_EXCEEDED',
        messageCode: 'anamnesis.conditionalDepthExceeded',
      });
    });

    it('does not throw when all conditions are met for a dichotomous parent', async () => {
      prisma.anamnesisQuestion.findUnique.mockResolvedValue(
        makeQuestion({
          id: 'parent-q',
          sectionId: 'section-1',
          type: AnamnesisQuestionType.DICHOTOMOUS,
          options: [],
          parentQuestionId: null,
        }),
      );

      await expect(
        validateParentLink({ parentId: 'parent-q', childSectionId: 'section-1', condition: { operator: 'equals', value: 'yes' } }, prisma),
      ).resolves.toBeUndefined();
    });
  });

  // ── addQuestion with conditional fields ──────────────────────────────────

  describe('addQuestion — conditional fields', () => {
    function setupForAddQuestion() {
      prisma.trainer.findUnique.mockResolvedValue(makeTrainer());
      prisma.anamnesis.findUnique.mockResolvedValue(makeAnamnesis());
      prisma.studentAnamnesis.count.mockResolvedValue(0);
      prisma.anamnesisSection.findUnique.mockResolvedValue(makeSection());
    }

    it('creates a conditional question with parentQuestionId and condition', async () => {
      setupForAddQuestion();

      // validateParentLink will call prisma.anamnesisQuestion.findUnique
      prisma.anamnesisQuestion.findUnique
        .mockResolvedValueOnce(
          // First call: validateParentLink — the parent question
          makeQuestion({
            id: 'parent-q',
            sectionId: 'section-1',
            type: AnamnesisQuestionType.DICHOTOMOUS,
            options: [],
            parentQuestionId: null,
          }),
        );

      const createdQuestion = makeQuestion({
        id: 'child-q',
        type: AnamnesisQuestionType.FREE_TEXT,
        parentQuestionId: 'parent-q',
        condition: { operator: 'equals', value: 'yes' },
        options: [],
      });
      prisma.anamnesisQuestion.create.mockResolvedValue({
        ...createdQuestion,
        dependentQuestions: [],
      });

      const result = await addQuestion('user-1', 'anamnesis-1', 'section-1', {
        text: 'How long have you been experiencing this?',
        type: AnamnesisQuestionType.FREE_TEXT,
        parentQuestionId: 'parent-q',
        condition: { operator: 'equals', value: 'yes' },
      });

      expect(result.parentQuestionId).toBe('parent-q');
      expect(result.condition).toEqual({ operator: 'equals', value: 'yes' });
      expect(prisma.anamnesisQuestion.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            parentQuestionId: 'parent-q',
            condition: { operator: 'equals', value: 'yes' },
          }),
        }),
      );
    });

    it('throws PARENT_MUST_BE_SAME_SECTION when parent is in a different section', async () => {
      setupForAddQuestion();

      prisma.anamnesisQuestion.findUnique.mockResolvedValue(
        makeQuestion({
          id: 'parent-q',
          sectionId: 'different-section',
          type: AnamnesisQuestionType.DICHOTOMOUS,
          options: [],
          parentQuestionId: null,
        }),
      );

      await expect(
        addQuestion('user-1', 'anamnesis-1', 'section-1', {
          text: 'Follow-up?',
          type: AnamnesisQuestionType.FREE_TEXT,
          parentQuestionId: 'parent-q',
          condition: { operator: 'equals', value: 'yes' },
        }),
      ).rejects.toMatchObject({
        httpStatus: 400,
        error: 'PARENT_MUST_BE_SAME_SECTION',
      });
    });

    it('throws CONDITIONAL_DEPTH_EXCEEDED when parent is itself a child', async () => {
      setupForAddQuestion();

      prisma.anamnesisQuestion.findUnique.mockResolvedValue(
        makeQuestion({
          id: 'parent-q',
          sectionId: 'section-1',
          type: AnamnesisQuestionType.DICHOTOMOUS,
          options: [],
          parentQuestionId: 'grandparent-q',
        }),
      );

      await expect(
        addQuestion('user-1', 'anamnesis-1', 'section-1', {
          text: 'Deep chain?',
          type: AnamnesisQuestionType.FREE_TEXT,
          parentQuestionId: 'parent-q',
          condition: { operator: 'equals', value: 'yes' },
        }),
      ).rejects.toMatchObject({
        httpStatus: 400,
        error: 'CONDITIONAL_DEPTH_EXCEEDED',
      });
    });
  });

  // ── updateQuestion — type-lock and option-removal guards ─────────────────

  describe('updateQuestion — conditional guards', () => {
    function setupForUpdateQuestion(questionOverrides = {}) {
      prisma.trainer.findUnique.mockResolvedValue(makeTrainer());
      prisma.anamnesis.findUnique.mockResolvedValue(makeAnamnesis());
      prisma.studentAnamnesis.count.mockResolvedValue(0);
      prisma.anamnesisSection.findUnique.mockResolvedValue(makeSection());
      prisma.anamnesisQuestion.findUnique.mockResolvedValue(
        makeQuestion({
          type: AnamnesisQuestionType.DICHOTOMOUS,
          parentQuestionId: null,
          condition: null,
          ...questionOverrides,
        }),
      );
    }

    it('throws PARENT_TYPE_LOCKED when changing type of a question with dependent children', async () => {
      setupForUpdateQuestion();
      // count returns 1 dependent child
      prisma.anamnesisQuestion.count.mockResolvedValue(1);

      await expect(
        updateQuestion('user-1', 'anamnesis-1', 'section-1', 'question-1', {
          type: AnamnesisQuestionType.FREE_TEXT,
        }),
      ).rejects.toMatchObject({
        httpStatus: 409,
        error: 'PARENT_TYPE_LOCKED',
        messageCode: 'anamnesis.parentTypeLocked',
      });
    });

    it('does not check type-lock when type is unchanged', async () => {
      setupForUpdateQuestion({ type: AnamnesisQuestionType.DICHOTOMOUS });
      prisma.anamnesisQuestion.count.mockResolvedValue(5); // count would fail if called

      prisma.$transaction.mockImplementation(async (fn) => {
        const tx = {
          anamnesisQuestionOption: { deleteMany: vi.fn(), createMany: vi.fn() },
          anamnesisQuestion: { update: vi.fn().mockResolvedValue(makeQuestion({ options: [], dependentQuestions: [] })) },
        };
        return fn(tx);
      });

      // Same type — no type-lock check; should not throw even though count > 0
      await expect(
        updateQuestion('user-1', 'anamnesis-1', 'section-1', 'question-1', {
          type: AnamnesisQuestionType.DICHOTOMOUS,
          text: 'Same type update',
        }),
      ).resolves.toBeDefined();

      // count should NOT have been called for type-lock
      expect(prisma.anamnesisQuestion.count).not.toHaveBeenCalled();
    });

    it('throws CONDITION_REFERENCES_REMOVED_OPTION when a referenced option is removed', async () => {
      setupForUpdateQuestion({
        type: AnamnesisQuestionType.SINGLE_CHOICE,
        options: [makeOption({ id: 'opt-1', text: 'Yes' }), makeOption({ id: 'opt-2', text: 'No' })],
      });
      prisma.anamnesisQuestion.count.mockResolvedValue(0); // no type change

      // findMany for childrenWithConditions
      prisma.anamnesisQuestion.findMany.mockResolvedValue([
        makeQuestion({
          id: 'child-q',
          condition: { operator: 'equals', optionId: 'opt-2' },
        }),
      ]);

      // findMany for existing options
      prisma.anamnesisQuestionOption.findMany.mockResolvedValue([
        makeOption({ id: 'opt-1', text: 'Yes' }),
        makeOption({ id: 'opt-2', text: 'No' }),
      ]);

      await expect(
        updateQuestion('user-1', 'anamnesis-1', 'section-1', 'question-1', {
          options: [{ text: 'Yes' }], // 'No' is being removed
        }),
      ).rejects.toMatchObject({
        httpStatus: 409,
        error: 'CONDITION_REFERENCES_REMOVED_OPTION',
        messageCode: 'anamnesis.conditionReferencesRemovedOption',
      });
    });

    it('allows removing an option that is not referenced by any child condition', async () => {
      setupForUpdateQuestion({
        type: AnamnesisQuestionType.SINGLE_CHOICE,
        options: [makeOption({ id: 'opt-1', text: 'Yes' }), makeOption({ id: 'opt-2', text: 'No' })],
      });
      prisma.anamnesisQuestion.count.mockResolvedValue(0);

      // child references opt-1, we're removing opt-2 (not referenced)
      prisma.anamnesisQuestion.findMany.mockResolvedValue([
        makeQuestion({
          id: 'child-q',
          condition: { operator: 'equals', optionId: 'opt-1' },
        }),
      ]);

      prisma.anamnesisQuestionOption.findMany.mockResolvedValue([
        makeOption({ id: 'opt-1', text: 'Yes' }),
        makeOption({ id: 'opt-2', text: 'No' }),
      ]);

      prisma.$transaction.mockImplementation(async (fn) => {
        const tx = {
          anamnesisQuestionOption: {
            deleteMany: vi.fn().mockResolvedValue({ count: 2 }),
            createMany: vi.fn().mockResolvedValue({ count: 1 }),
          },
          anamnesisQuestion: {
            update: vi.fn().mockResolvedValue(makeQuestion({ options: [], dependentQuestions: [] })),
          },
        };
        return fn(tx);
      });

      await expect(
        updateQuestion('user-1', 'anamnesis-1', 'section-1', 'question-1', {
          options: [{ text: 'Yes' }], // opt-2 removed but not referenced
        }),
      ).resolves.toBeDefined();
    });
  });

  // ── submitAnamnesisResponse — conditional visibility ──────────────────────

  describe('submitAnamnesisResponse — conditional visibility', () => {
    function makeAnamnesisWithConditional() {
      const parentQuestion = makeQuestion({
        id: 'parent-q',
        required: true,
        type: AnamnesisQuestionType.DICHOTOMOUS,
        parentQuestionId: null,
        condition: null,
      });
      const childQuestion = makeQuestion({
        id: 'child-q',
        required: true,
        type: AnamnesisQuestionType.FREE_TEXT,
        parentQuestionId: 'parent-q',
        condition: { operator: 'equals', value: 'yes' },
      });

      return {
        ...makeAnamnesis(),
        sections: [
          {
            ...makeSection(),
            questions: [parentQuestion, childQuestion],
          },
        ],
      };
    }

    it('does not require a hidden child when parent answer is "no"', async () => {
      prisma.studentAnamnesis.findFirst.mockResolvedValue({ id: 'link-1' });
      prisma.anamnesis.findUnique.mockResolvedValue(makeAnamnesisWithConditional());

      prisma.$transaction.mockImplementation(async (fn) => {
        const tx = {
          anamnesisResponse: {
            upsert: vi.fn().mockResolvedValue({ id: 'response-1' }),
            findUnique: vi.fn().mockResolvedValue({
              id: 'response-1',
              anamnesisId: 'anamnesis-1',
              studentId: 'student-1',
              submittedAt: new Date(),
              answers: [],
            }),
          },
          anamnesisAnswer: {
            deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
            createMany: vi.fn().mockResolvedValue({ count: 1 }),
          },
        };
        return fn(tx);
      });

      // Parent is answered "no" — child is hidden, so its required check is skipped
      await expect(
        submitAnamnesisResponse('student-1', 'anamnesis-1', {
          answers: [{ questionId: 'parent-q', value: 'no' }],
        }),
      ).resolves.toBeDefined();
    });

    it('requires the child question when parent answer is "yes" (child is visible)', async () => {
      prisma.studentAnamnesis.findFirst.mockResolvedValue({ id: 'link-1' });
      prisma.anamnesis.findUnique.mockResolvedValue(makeAnamnesisWithConditional());

      // Parent answered "yes" but child is not answered — should fail required validation
      await expect(
        submitAnamnesisResponse('student-1', 'anamnesis-1', {
          answers: [{ questionId: 'parent-q', value: 'yes' }],
        }),
      ).rejects.toMatchObject({
        httpStatus: 400,
        error: 'VALIDATION_ERROR',
        messageCode: 'validation.failed',
      });
    });

    it('drops answers for hidden child questions before persisting', async () => {
      prisma.studentAnamnesis.findFirst.mockResolvedValue({ id: 'link-1' });
      prisma.anamnesis.findUnique.mockResolvedValue(makeAnamnesisWithConditional());

      let capturedCreateManyData;
      prisma.$transaction.mockImplementation(async (fn) => {
        const tx = {
          anamnesisResponse: {
            upsert: vi.fn().mockResolvedValue({ id: 'response-1' }),
            findUnique: vi.fn().mockResolvedValue({
              id: 'response-1',
              anamnesisId: 'anamnesis-1',
              studentId: 'student-1',
              submittedAt: new Date(),
              answers: [],
            }),
          },
          anamnesisAnswer: {
            deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
            createMany: vi.fn().mockImplementation((args) => {
              capturedCreateManyData = args.data;
              return Promise.resolve({ count: args.data.length });
            }),
          },
        };
        return fn(tx);
      });

      // Parent is "no", but student also submitted an answer for the hidden child
      await submitAnamnesisResponse('student-1', 'anamnesis-1', {
        answers: [
          { questionId: 'parent-q', value: 'no' },
          { questionId: 'child-q', value: 'some hidden answer' }, // should be dropped
        ],
      });

      // Only parent answer should have been persisted
      expect(capturedCreateManyData).toHaveLength(1);
      expect(capturedCreateManyData[0].questionId).toBe('parent-q');
    });
  });

  // ── normalizeChoiceAnswersForVisibility (pure function) ───────────────────

  describe('normalizeChoiceAnswersForVisibility', () => {
    const options = [
      { id: 'opt-uuid-1', text: 'Option A', order: 0 },
      { id: 'opt-uuid-2', text: 'Option B', order: 1 },
      { id: 'opt-uuid-3', text: 'Option C', order: 2 },
    ];

    const makeQuestionsById = (entries) => new Map(entries);

    it('SINGLE_CHOICE: maps option text to option id', () => {
      const questionsById = makeQuestionsById([
        ['q-1', { type: AnamnesisQuestionType.SINGLE_CHOICE, options }],
      ]);
      const result = normalizeChoiceAnswersForVisibility(
        [{ questionId: 'q-1', value: 'Option A' }],
        questionsById,
      );
      expect(result.get('q-1')).toBe('opt-uuid-1');
    });

    it('SINGLE_CHOICE: passes through when value is already an option id', () => {
      const questionsById = makeQuestionsById([
        ['q-1', { type: AnamnesisQuestionType.SINGLE_CHOICE, options }],
      ]);
      const result = normalizeChoiceAnswersForVisibility(
        [{ questionId: 'q-1', value: 'opt-uuid-2' }],
        questionsById,
      );
      expect(result.get('q-1')).toBe('opt-uuid-2');
    });

    it('SINGLE_CHOICE: leaves value unchanged when it matches neither text nor id', () => {
      const questionsById = makeQuestionsById([
        ['q-1', { type: AnamnesisQuestionType.SINGLE_CHOICE, options }],
      ]);
      const result = normalizeChoiceAnswersForVisibility(
        [{ questionId: 'q-1', value: 'Unknown Option' }],
        questionsById,
      );
      expect(result.get('q-1')).toBe('Unknown Option');
    });

    it('MULTIPLE_CHOICE: maps array of texts to array of ids', () => {
      const questionsById = makeQuestionsById([
        ['q-1', { type: AnamnesisQuestionType.MULTIPLE_CHOICE, options }],
      ]);
      const result = normalizeChoiceAnswersForVisibility(
        [{ questionId: 'q-1', value: ['Option A', 'Option C'] }],
        questionsById,
      );
      expect(result.get('q-1')).toEqual(['opt-uuid-1', 'opt-uuid-3']);
    });

    it('MULTIPLE_CHOICE: handles mixed array of texts and ids', () => {
      const questionsById = makeQuestionsById([
        ['q-1', { type: AnamnesisQuestionType.MULTIPLE_CHOICE, options }],
      ]);
      const result = normalizeChoiceAnswersForVisibility(
        [{ questionId: 'q-1', value: ['opt-uuid-1', 'Option B'] }],
        questionsById,
      );
      expect(result.get('q-1')).toEqual(['opt-uuid-1', 'opt-uuid-2']);
    });

    it('MULTIPLE_CHOICE: leaves unknown text entries unchanged in the array', () => {
      const questionsById = makeQuestionsById([
        ['q-1', { type: AnamnesisQuestionType.MULTIPLE_CHOICE, options }],
      ]);
      const result = normalizeChoiceAnswersForVisibility(
        [{ questionId: 'q-1', value: ['Option A', 'Unknown'] }],
        questionsById,
      );
      expect(result.get('q-1')).toEqual(['opt-uuid-1', 'Unknown']);
    });

    it('MULTIPLE_CHOICE: non-array value passes through unchanged', () => {
      const questionsById = makeQuestionsById([
        ['q-1', { type: AnamnesisQuestionType.MULTIPLE_CHOICE, options }],
      ]);
      const result = normalizeChoiceAnswersForVisibility(
        [{ questionId: 'q-1', value: 'Option A' }],
        questionsById,
      );
      expect(result.get('q-1')).toBe('Option A');
    });

    it('FREE_TEXT: passes through unchanged', () => {
      const questionsById = makeQuestionsById([
        ['q-1', { type: AnamnesisQuestionType.FREE_TEXT, options: [] }],
      ]);
      const result = normalizeChoiceAnswersForVisibility(
        [{ questionId: 'q-1', value: 'some free text' }],
        questionsById,
      );
      expect(result.get('q-1')).toBe('some free text');
    });

    it('DICHOTOMOUS: yes/no passes through unchanged', () => {
      const questionsById = makeQuestionsById([
        ['q-1', { type: AnamnesisQuestionType.DICHOTOMOUS, options: [] }],
      ]);
      const result = normalizeChoiceAnswersForVisibility(
        [{ questionId: 'q-1', value: 'yes' }],
        questionsById,
      );
      expect(result.get('q-1')).toBe('yes');
    });

    it('null answer value passes through unchanged', () => {
      const questionsById = makeQuestionsById([
        ['q-1', { type: AnamnesisQuestionType.SINGLE_CHOICE, options }],
      ]);
      const result = normalizeChoiceAnswersForVisibility(
        [{ questionId: 'q-1', value: null }],
        questionsById,
      );
      expect(result.get('q-1')).toBeNull();
    });

    it('question not found in questionsById: answer passes through unchanged', () => {
      const questionsById = makeQuestionsById([]);
      const result = normalizeChoiceAnswersForVisibility(
        [{ questionId: 'unknown-q', value: 'Option A' }],
        questionsById,
      );
      expect(result.get('unknown-q')).toBe('Option A');
    });

    it('empty answers array returns empty Map', () => {
      const questionsById = makeQuestionsById([
        ['q-1', { type: AnamnesisQuestionType.SINGLE_CHOICE, options }],
      ]);
      const result = normalizeChoiceAnswersForVisibility([], questionsById);
      expect(result.size).toBe(0);
    });
  });

  // ── submitAnamnesisResponse — SINGLE_CHOICE parent normalization ──────────

  describe('submitAnamnesisResponse — SINGLE_CHOICE parent normalization', () => {
    const singleChoiceOptions = [
      { id: 'opt-uuid-1', text: 'Option A', order: 0 },
      { id: 'opt-uuid-2', text: 'Option B', order: 1 },
    ];

    function makeAnamnesisWithSingleChoiceConditional() {
      const parentQuestion = makeQuestion({
        id: 'parent-sc',
        required: true,
        type: AnamnesisQuestionType.SINGLE_CHOICE,
        parentQuestionId: null,
        condition: null,
        options: singleChoiceOptions,
      });
      const childQuestion = makeQuestion({
        id: 'child-sc',
        required: true,
        type: AnamnesisQuestionType.FREE_TEXT,
        parentQuestionId: 'parent-sc',
        condition: { operator: 'equals', optionId: 'opt-uuid-1' },
        options: [],
      });

      return {
        ...makeAnamnesis(),
        sections: [
          {
            ...makeSection(),
            questions: [parentQuestion, childQuestion],
          },
        ],
      };
    }

    it('child is required when student submits option text matching the trigger', async () => {
      prisma.studentAnamnesis.findFirst.mockResolvedValue({ id: 'link-1' });
      prisma.anamnesis.findUnique.mockResolvedValue(makeAnamnesisWithSingleChoiceConditional());

      // Parent answered with option TEXT "Option A" — child (opt-uuid-1 trigger) should be visible
      await expect(
        submitAnamnesisResponse('student-1', 'anamnesis-1', {
          answers: [{ questionId: 'parent-sc', value: 'Option A' }],
        }),
      ).rejects.toMatchObject({
        httpStatus: 400,
        error: 'VALIDATION_ERROR',
        messageCode: 'validation.failed',
      });
    });

    it('child answer is persisted with original text value (not normalized UUID)', async () => {
      prisma.studentAnamnesis.findFirst.mockResolvedValue({ id: 'link-1' });
      prisma.anamnesis.findUnique.mockResolvedValue(makeAnamnesisWithSingleChoiceConditional());

      let capturedCreateManyData;
      prisma.$transaction.mockImplementation(async (fn) => {
        const tx = {
          anamnesisResponse: {
            upsert: vi.fn().mockResolvedValue({ id: 'response-1' }),
            findUnique: vi.fn().mockResolvedValue({
              id: 'response-1',
              anamnesisId: 'anamnesis-1',
              studentId: 'student-1',
              submittedAt: new Date(),
              answers: [],
            }),
          },
          anamnesisAnswer: {
            deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
            createMany: vi.fn().mockImplementation((args) => {
              capturedCreateManyData = args.data;
              return Promise.resolve({ count: args.data.length });
            }),
          },
        };
        return fn(tx);
      });

      await submitAnamnesisResponse('student-1', 'anamnesis-1', {
        answers: [
          { questionId: 'parent-sc', value: 'Option A' },
          { questionId: 'child-sc', value: 'some child text answer' },
        ],
      });

      // Parent must be persisted with original text value, not the UUID
      const parentPersisted = capturedCreateManyData.find((a) => a.questionId === 'parent-sc');
      expect(parentPersisted.value).toBe('Option A');

      // Child must be persisted with its original answer
      const childPersisted = capturedCreateManyData.find((a) => a.questionId === 'child-sc');
      expect(childPersisted.value).toBe('some child text answer');
    });

    it('child is hidden when student submits option text for a non-triggering option', async () => {
      prisma.studentAnamnesis.findFirst.mockResolvedValue({ id: 'link-1' });
      prisma.anamnesis.findUnique.mockResolvedValue(makeAnamnesisWithSingleChoiceConditional());

      prisma.$transaction.mockImplementation(async (fn) => {
        const tx = {
          anamnesisResponse: {
            upsert: vi.fn().mockResolvedValue({ id: 'response-1' }),
            findUnique: vi.fn().mockResolvedValue({
              id: 'response-1',
              anamnesisId: 'anamnesis-1',
              studentId: 'student-1',
              submittedAt: new Date(),
              answers: [],
            }),
          },
          anamnesisAnswer: {
            deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
            createMany: vi.fn().mockResolvedValue({ count: 1 }),
          },
        };
        return fn(tx);
      });

      // "Option B" does not trigger child (condition requires opt-uuid-1 = "Option A")
      await expect(
        submitAnamnesisResponse('student-1', 'anamnesis-1', {
          answers: [{ questionId: 'parent-sc', value: 'Option B' }],
        }),
      ).resolves.toBeDefined();
    });
  });

  // ── submitAnamnesisResponse — MULTIPLE_CHOICE parent normalization ─────────

  describe('submitAnamnesisResponse — MULTIPLE_CHOICE parent normalization', () => {
    const multiChoiceOptions = [
      { id: 'opt-uuid-1', text: 'Option A', order: 0 },
      { id: 'opt-uuid-2', text: 'Option B', order: 1 },
      { id: 'opt-uuid-3', text: 'Option C', order: 2 },
    ];

    function makeAnamnesisWithMultipleChoiceConditional() {
      const parentQuestion = makeQuestion({
        id: 'parent-mc',
        required: true,
        type: AnamnesisQuestionType.MULTIPLE_CHOICE,
        parentQuestionId: null,
        condition: null,
        options: multiChoiceOptions,
      });
      const childQuestion = makeQuestion({
        id: 'child-mc',
        required: true,
        type: AnamnesisQuestionType.FREE_TEXT,
        parentQuestionId: 'parent-mc',
        condition: { operator: 'includesAny', optionIds: ['opt-uuid-1', 'opt-uuid-2'] },
        options: [],
      });

      return {
        ...makeAnamnesis(),
        sections: [
          {
            ...makeSection(),
            questions: [parentQuestion, childQuestion],
          },
        ],
      };
    }

    it('child is required when text array contains a triggering option', async () => {
      prisma.studentAnamnesis.findFirst.mockResolvedValue({ id: 'link-1' });
      prisma.anamnesis.findUnique.mockResolvedValue(makeAnamnesisWithMultipleChoiceConditional());

      // "Option A" maps to opt-uuid-1 which is in the trigger list — child is visible
      await expect(
        submitAnamnesisResponse('student-1', 'anamnesis-1', {
          answers: [{ questionId: 'parent-mc', value: ['Option A', 'Option C'] }],
        }),
      ).rejects.toMatchObject({
        httpStatus: 400,
        error: 'VALIDATION_ERROR',
        messageCode: 'validation.failed',
      });
    });

    it('child is hidden when text array contains no triggering options', async () => {
      prisma.studentAnamnesis.findFirst.mockResolvedValue({ id: 'link-1' });
      prisma.anamnesis.findUnique.mockResolvedValue(makeAnamnesisWithMultipleChoiceConditional());

      prisma.$transaction.mockImplementation(async (fn) => {
        const tx = {
          anamnesisResponse: {
            upsert: vi.fn().mockResolvedValue({ id: 'response-1' }),
            findUnique: vi.fn().mockResolvedValue({
              id: 'response-1',
              anamnesisId: 'anamnesis-1',
              studentId: 'student-1',
              submittedAt: new Date(),
              answers: [],
            }),
          },
          anamnesisAnswer: {
            deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
            createMany: vi.fn().mockResolvedValue({ count: 1 }),
          },
        };
        return fn(tx);
      });

      // "Option C" maps to opt-uuid-3 which is NOT in trigger list — child stays hidden
      await expect(
        submitAnamnesisResponse('student-1', 'anamnesis-1', {
          answers: [{ questionId: 'parent-mc', value: ['Option C'] }],
        }),
      ).resolves.toBeDefined();
    });

    it('child answer is persisted with original text array (not normalized UUIDs)', async () => {
      prisma.studentAnamnesis.findFirst.mockResolvedValue({ id: 'link-1' });
      prisma.anamnesis.findUnique.mockResolvedValue(makeAnamnesisWithMultipleChoiceConditional());

      let capturedCreateManyData;
      prisma.$transaction.mockImplementation(async (fn) => {
        const tx = {
          anamnesisResponse: {
            upsert: vi.fn().mockResolvedValue({ id: 'response-1' }),
            findUnique: vi.fn().mockResolvedValue({
              id: 'response-1',
              anamnesisId: 'anamnesis-1',
              studentId: 'student-1',
              submittedAt: new Date(),
              answers: [],
            }),
          },
          anamnesisAnswer: {
            deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
            createMany: vi.fn().mockImplementation((args) => {
              capturedCreateManyData = args.data;
              return Promise.resolve({ count: args.data.length });
            }),
          },
        };
        return fn(tx);
      });

      await submitAnamnesisResponse('student-1', 'anamnesis-1', {
        answers: [
          { questionId: 'parent-mc', value: ['Option A'] },
          { questionId: 'child-mc', value: 'some free text' },
        ],
      });

      // Parent must be persisted as original text array
      const parentPersisted = capturedCreateManyData.find((a) => a.questionId === 'parent-mc');
      expect(parentPersisted.value).toEqual(['Option A']);

      // Child must be persisted with its original answer
      const childPersisted = capturedCreateManyData.find((a) => a.questionId === 'child-mc');
      expect(childPersisted.value).toBe('some free text');
    });
  });
});
