import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  listAdvancedTechniques,
  getAdvancedTechniqueById,
  createAdvancedTechnique,
  updateAdvancedTechnique,
  deleteAdvancedTechnique,
  resolveAdvancedTechniqueSelection,
} from '../../src/services/advanced-technique-service.js';
import {
  AdvancedTechniqueErrorCode,
  AdvancedTechniqueMessageCode,
} from '../../src/constants/advanced-technique.js';

const USER_ID = 'user-1';
const TRAINER_ID = 'trainer-1';
const OTHER_TRAINER_ID = 'trainer-2';
const NOW = new Date('2026-01-01T00:00:00.000Z');

// Builds an own-technique row with sensible defaults.
const makeTechnique = (overrides = {}) => ({
  id: 'tech-1',
  trainerId: TRAINER_ID,
  key: null,
  name: 'My technique',
  description: 'Does a thing',
  videoUrl: null,
  gifUrl: null,
  deletedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

// Builds a system-technique row (trainerId null, stable key).
const makeSystemTechnique = (overrides = {}) =>
  makeTechnique({ id: 'tech-sys', trainerId: null, key: 'drop_set', name: 'Drop set', ...overrides });

// Evaluates the subset of the Prisma `where` the service uses (id in, deletedAt null, OR trainerId) over in-memory rows.
function fakeFindMany(rows) {
  return async ({ where }) =>
    rows.filter((row) => {
      if (where?.id?.in && !where.id.in.includes(row.id)) return false;
      if (where && 'deletedAt' in where && where.deletedAt === null && row.deletedAt) return false;
      if (where?.OR && !where.OR.some((clause) => 'trainerId' in clause && clause.trainerId === row.trainerId)) {
        return false;
      }
      return true;
    });
}

let db;

beforeEach(() => {
  db = {
    trainer: { findUnique: vi.fn().mockResolvedValue({ id: TRAINER_ID }) },
    advancedTechnique: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
  };
});

describe('advanced-technique-service', () => {
  describe('listAdvancedTechniques', () => {
    it('should query system techniques plus own, excluding soft-deleted, and return the paginated envelope', async () => {
      const rows = [makeSystemTechnique(), makeTechnique()];
      db.advancedTechnique.findMany.mockResolvedValue(rows);
      db.advancedTechnique.count.mockResolvedValue(2);

      const result = await listAdvancedTechniques(db, USER_ID, {});

      const { where } = db.advancedTechnique.findMany.mock.calls[0][0];
      expect(where.deletedAt).toBeNull();
      expect(where.OR).toEqual(
        expect.arrayContaining([{ trainerId: null }, { trainerId: TRAINER_ID }]),
      );
      expect(result).toMatchObject({ total: 2, page: 1, limit: 20 });
      expect(result.data).toHaveLength(2);
    });

    it('should expose isSystem true for system rows and false for own rows', async () => {
      db.advancedTechnique.findMany.mockResolvedValue([makeSystemTechnique(), makeTechnique()]);
      db.advancedTechnique.count.mockResolvedValue(2);

      const { data } = await listAdvancedTechniques(db, USER_ID, {});

      expect(data[0]).toMatchObject({ id: 'tech-sys', key: 'drop_set', isSystem: true, trainerId: null });
      expect(data[1]).toMatchObject({ id: 'tech-1', key: null, isSystem: false, trainerId: TRAINER_ID });
    });

    it('should apply a case-insensitive name contains filter when q is given', async () => {
      db.advancedTechnique.findMany.mockResolvedValue([]);
      db.advancedTechnique.count.mockResolvedValue(0);

      await listAdvancedTechniques(db, USER_ID, { q: 'DROP' });

      const { where } = db.advancedTechnique.findMany.mock.calls[0][0];
      expect(where.name).toEqual({ contains: 'DROP', mode: 'insensitive' });
    });

    it('should translate page and limit into skip and take', async () => {
      db.advancedTechnique.findMany.mockResolvedValue([]);
      db.advancedTechnique.count.mockResolvedValue(0);

      const result = await listAdvancedTechniques(db, USER_ID, { page: 3, limit: 5 });

      expect(db.advancedTechnique.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 10, take: 5 }),
      );
      expect(result).toMatchObject({ page: 3, limit: 5 });
    });
  });

  describe('getAdvancedTechniqueById', () => {
    it('should return a system technique with isSystem true', async () => {
      db.advancedTechnique.findUnique.mockResolvedValue(makeSystemTechnique());

      const result = await getAdvancedTechniqueById(db, USER_ID, 'tech-sys');

      expect(result).toMatchObject({ id: 'tech-sys', isSystem: true });
    });

    it('should return an own technique', async () => {
      db.advancedTechnique.findUnique.mockResolvedValue(makeTechnique());

      const result = await getAdvancedTechniqueById(db, USER_ID, 'tech-1');

      expect(result).toMatchObject({ id: 'tech-1', isSystem: false, trainerId: TRAINER_ID });
    });

    it.each([
      ['does not exist', null],
      ['is soft-deleted', makeTechnique({ deletedAt: NOW })],
      ['is private to another trainer', makeTechnique({ trainerId: OTHER_TRAINER_ID })],
    ])('should throw 404 ADVANCED_TECHNIQUE_NOT_FOUND when the technique %s', async (_label, row) => {
      db.advancedTechnique.findUnique.mockResolvedValue(row);

      await expect(getAdvancedTechniqueById(db, USER_ID, 'tech-1')).rejects.toMatchObject({
        httpStatus: 404,
        error: AdvancedTechniqueErrorCode.NOT_FOUND,
        messageCode: AdvancedTechniqueMessageCode.NOT_FOUND,
      });
    });
  });

  describe('createAdvancedTechnique', () => {
    it('should create a technique owned by the trainer with no key', async () => {
      db.advancedTechnique.create.mockImplementation(async ({ data }) => makeTechnique(data));

      const result = await createAdvancedTechnique(db, USER_ID, {
        name: 'Myo-reps',
        description: 'Activation set then mini-sets',
      });

      const { data } = db.advancedTechnique.create.mock.calls[0][0];
      expect(data).toMatchObject({
        trainerId: TRAINER_ID,
        name: 'Myo-reps',
        description: 'Activation set then mini-sets',
        videoUrl: null,
        gifUrl: null,
      });
      expect(data.key ?? null).toBeNull();
      expect(result).toMatchObject({ name: 'Myo-reps', isSystem: false });
    });

    it('should persist videoUrl and gifUrl when provided', async () => {
      db.advancedTechnique.create.mockImplementation(async ({ data }) => makeTechnique(data));

      await createAdvancedTechnique(db, USER_ID, {
        name: 'Myo-reps',
        description: 'desc',
        videoUrl: 'https://youtu.be/abc',
        gifUrl: 'https://example.com/a.gif',
      });

      expect(db.advancedTechnique.create.mock.calls[0][0].data).toMatchObject({
        videoUrl: 'https://youtu.be/abc',
        gifUrl: 'https://example.com/a.gif',
      });
    });
  });

  describe('updateAdvancedTechnique', () => {
    it('should update only the provided fields of an own technique', async () => {
      db.advancedTechnique.findUnique.mockResolvedValue(makeTechnique());
      db.advancedTechnique.update.mockImplementation(async ({ data }) => makeTechnique(data));

      await updateAdvancedTechnique(db, USER_ID, 'tech-1', { name: 'Renamed' });

      expect(db.advancedTechnique.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'tech-1' }, data: { name: 'Renamed' } }),
      );
    });

    it('should clear gifUrl when null is sent', async () => {
      db.advancedTechnique.findUnique.mockResolvedValue(makeTechnique({ gifUrl: 'https://example.com/a.gif' }));
      db.advancedTechnique.update.mockImplementation(async ({ data }) => makeTechnique(data));

      await updateAdvancedTechnique(db, USER_ID, 'tech-1', { gifUrl: null });

      expect(db.advancedTechnique.update.mock.calls[0][0].data).toEqual({ gifUrl: null });
    });

    it('should throw 403 ADVANCED_TECHNIQUE_FORBIDDEN for a system technique', async () => {
      db.advancedTechnique.findUnique.mockResolvedValue(makeSystemTechnique());

      await expect(
        updateAdvancedTechnique(db, USER_ID, 'tech-sys', { name: 'Hacked' }),
      ).rejects.toMatchObject({
        httpStatus: 403,
        error: AdvancedTechniqueErrorCode.FORBIDDEN,
        messageCode: AdvancedTechniqueMessageCode.FORBIDDEN,
      });
      expect(db.advancedTechnique.update).not.toHaveBeenCalled();
    });

    it.each([
      ['does not exist', null],
      ['is soft-deleted', makeTechnique({ deletedAt: NOW })],
      ['belongs to another trainer', makeTechnique({ trainerId: OTHER_TRAINER_ID })],
    ])('should throw 404 ADVANCED_TECHNIQUE_NOT_FOUND when the technique %s', async (_label, row) => {
      db.advancedTechnique.findUnique.mockResolvedValue(row);

      await expect(
        updateAdvancedTechnique(db, USER_ID, 'tech-1', { name: 'X' }),
      ).rejects.toMatchObject({
        httpStatus: 404,
        error: AdvancedTechniqueErrorCode.NOT_FOUND,
        messageCode: AdvancedTechniqueMessageCode.NOT_FOUND,
      });
      expect(db.advancedTechnique.update).not.toHaveBeenCalled();
    });
  });

  describe('deleteAdvancedTechnique', () => {
    it('should soft delete an own technique by setting deletedAt', async () => {
      db.advancedTechnique.findUnique.mockResolvedValue(makeTechnique());
      db.advancedTechnique.update.mockImplementation(async ({ data }) => makeTechnique(data));

      await deleteAdvancedTechnique(db, USER_ID, 'tech-1');

      const call = db.advancedTechnique.update.mock.calls[0][0];
      expect(call.where).toEqual({ id: 'tech-1' });
      expect(call.data.deletedAt).toBeInstanceOf(Date);
    });

    it('should throw 403 ADVANCED_TECHNIQUE_FORBIDDEN for a system technique', async () => {
      db.advancedTechnique.findUnique.mockResolvedValue(makeSystemTechnique());

      await expect(deleteAdvancedTechnique(db, USER_ID, 'tech-sys')).rejects.toMatchObject({
        httpStatus: 403,
        error: AdvancedTechniqueErrorCode.FORBIDDEN,
        messageCode: AdvancedTechniqueMessageCode.FORBIDDEN,
      });
      expect(db.advancedTechnique.update).not.toHaveBeenCalled();
    });

    it.each([
      ['does not exist', null],
      ['is already soft-deleted', makeTechnique({ deletedAt: NOW })],
      ['belongs to another trainer', makeTechnique({ trainerId: OTHER_TRAINER_ID })],
    ])('should throw 404 ADVANCED_TECHNIQUE_NOT_FOUND when the technique %s', async (_label, row) => {
      db.advancedTechnique.findUnique.mockResolvedValue(row);

      await expect(deleteAdvancedTechnique(db, USER_ID, 'tech-1')).rejects.toMatchObject({
        httpStatus: 404,
        error: AdvancedTechniqueErrorCode.NOT_FOUND,
        messageCode: AdvancedTechniqueMessageCode.NOT_FOUND,
      });
      expect(db.advancedTechnique.update).not.toHaveBeenCalled();
    });
  });

  describe('resolveAdvancedTechniqueSelection', () => {
    it('should return an empty list without querying when ids is empty', async () => {
      const result = await resolveAdvancedTechniqueSelection(db, TRAINER_ID, []);

      expect(result).toEqual([]);
      expect(db.advancedTechnique.findMany).not.toHaveBeenCalled();
    });

    it('should return an empty list when ids is undefined', async () => {
      const result = await resolveAdvancedTechniqueSelection(db, TRAINER_ID, undefined);

      expect(result).toEqual([]);
    });

    it('should map ids to { advancedTechniqueId, order } using the array index, regardless of DB row order', async () => {
      db.advancedTechnique.findMany.mockImplementation(
        fakeFindMany([makeTechnique({ id: 'a' }), makeTechnique({ id: 'b' }), makeSystemTechnique({ id: 'c' })]),
      );

      const result = await resolveAdvancedTechniqueSelection(db, TRAINER_ID, ['c', 'a', 'b']);

      expect(result).toEqual([
        { advancedTechniqueId: 'c', order: 0 },
        { advancedTechniqueId: 'a', order: 1 },
        { advancedTechniqueId: 'b', order: 2 },
      ]);
    });

    it('should accept system techniques', async () => {
      db.advancedTechnique.findMany.mockImplementation(fakeFindMany([makeSystemTechnique({ id: 'sys' })]));

      const result = await resolveAdvancedTechniqueSelection(db, TRAINER_ID, ['sys']);

      expect(result).toEqual([{ advancedTechniqueId: 'sys', order: 0 }]);
    });

    it.each([
      ['does not exist', []],
      ['is soft-deleted', [makeTechnique({ id: 'a', deletedAt: NOW })]],
      ['is private to another trainer', [makeTechnique({ id: 'a', trainerId: OTHER_TRAINER_ID })]],
    ])('should throw 400 ADVANCED_TECHNIQUE_INVALID_SELECTION when a selected technique %s', async (_label, rows) => {
      db.advancedTechnique.findMany.mockImplementation(fakeFindMany(rows));

      await expect(resolveAdvancedTechniqueSelection(db, TRAINER_ID, ['a'])).rejects.toMatchObject({
        httpStatus: 400,
        error: AdvancedTechniqueErrorCode.INVALID_SELECTION,
        messageCode: AdvancedTechniqueMessageCode.INVALID_SELECTION,
      });
    });

    it('should reject the whole selection when only one of several ids is invalid', async () => {
      db.advancedTechnique.findMany.mockImplementation(fakeFindMany([makeTechnique({ id: 'a' })]));

      await expect(
        resolveAdvancedTechniqueSelection(db, TRAINER_ID, ['a', 'missing']),
      ).rejects.toMatchObject({ error: AdvancedTechniqueErrorCode.INVALID_SELECTION });
    });
  });

  describe('error constants', () => {
    it('should expose the stable error codes and messageCodes', () => {
      expect(AdvancedTechniqueErrorCode).toMatchObject({
        NOT_FOUND: 'ADVANCED_TECHNIQUE_NOT_FOUND',
        FORBIDDEN: 'ADVANCED_TECHNIQUE_FORBIDDEN',
        INVALID_SELECTION: 'ADVANCED_TECHNIQUE_INVALID_SELECTION',
      });
      expect(AdvancedTechniqueMessageCode).toMatchObject({
        NOT_FOUND: 'advancedTechnique.notFound',
        FORBIDDEN: 'advancedTechnique.forbidden',
        INVALID_SELECTION: 'advancedTechnique.invalidSelection',
      });
    });
  });
});
