import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  resolveAdvancedTechniqueSelectionBatch,
  inheritSelectionBatch,
  resolveSelectionOrInherit,
} from '../../src/services/advanced-technique-service.js';
import {
  AdvancedTechniqueErrorCode,
  AdvancedTechniqueMessageCode,
} from '../../src/constants/advanced-technique.js';

const TRAINER_ID = 'trainer-1';

let db;

// Makes the technique lookup return only the given ids as visible.
function mockVisibleIds(ids) {
  db.advancedTechnique.findMany.mockResolvedValue(ids.map((id) => ({ id })));
}

// Builds a link row as stored on a template / junction / exercise.
const makeLink = (advancedTechniqueId, order) => ({ advancedTechniqueId, order });

beforeEach(() => {
  db = { advancedTechnique: { findMany: vi.fn().mockResolvedValue([]) } };
});

describe('advanced-technique inheritance helpers', () => {
  describe('resolveAdvancedTechniqueSelectionBatch', () => {
    it('validates every list with a single query and indexes each list by position', async () => {
      mockVisibleIds(['a', 'b', 'c']);

      const result = await resolveAdvancedTechniqueSelectionBatch(db, TRAINER_ID, [['a', 'b'], ['c', 'a']]);

      expect(db.advancedTechnique.findMany).toHaveBeenCalledTimes(1);
      expect(result).toEqual([
        [
          { advancedTechniqueId: 'a', order: 0 },
          { advancedTechniqueId: 'b', order: 1 },
        ],
        [
          { advancedTechniqueId: 'c', order: 0 },
          { advancedTechniqueId: 'a', order: 1 },
        ],
      ]);
    });

    it('queries each distinct id once and scopes visibility to system plus own techniques', async () => {
      mockVisibleIds(['a', 'b']);

      await resolveAdvancedTechniqueSelectionBatch(db, TRAINER_ID, [['a', 'b'], ['a']]);

      expect(db.advancedTechnique.findMany).toHaveBeenCalledWith({
        where: { id: { in: ['a', 'b'] }, deletedAt: null, OR: [{ trainerId: null }, { trainerId: TRAINER_ID }] },
        select: { id: true },
      });
    });

    it('maps undefined lists to empty selections', async () => {
      mockVisibleIds(['a']);

      const result = await resolveAdvancedTechniqueSelectionBatch(db, TRAINER_ID, [undefined, ['a']]);

      expect(result).toEqual([[], [{ advancedTechniqueId: 'a', order: 0 }]]);
    });

    it('skips the query when no list has ids', async () => {
      const result = await resolveAdvancedTechniqueSelectionBatch(db, TRAINER_ID, [undefined, []]);

      expect(result).toEqual([[], []]);
      expect(db.advancedTechnique.findMany).not.toHaveBeenCalled();
    });

    it('throws 400 ADVANCED_TECHNIQUE_INVALID_SELECTION when any id is not visible', async () => {
      mockVisibleIds(['a']);

      await expect(
        resolveAdvancedTechniqueSelectionBatch(db, TRAINER_ID, [['a'], ['ghost']]),
      ).rejects.toMatchObject({
        statusCode: 400,
        error: AdvancedTechniqueErrorCode.INVALID_SELECTION,
        messageCode: AdvancedTechniqueMessageCode.INVALID_SELECTION,
      });
    });
  });

  describe('inheritSelectionBatch', () => {
    it('re-indexes each list by its source order', async () => {
      mockVisibleIds(['a', 'b', 'c']);

      const result = await inheritSelectionBatch(db, TRAINER_ID, [
        [makeLink('b', 5), makeLink('a', 2)],
        [makeLink('c', 9)],
      ]);

      expect(result).toEqual([
        [
          { advancedTechniqueId: 'a', order: 0 },
          { advancedTechniqueId: 'b', order: 1 },
        ],
        [{ advancedTechniqueId: 'c', order: 0 }],
      ]);
    });

    it('drops ids that are no longer visible and closes the order gap', async () => {
      mockVisibleIds(['a', 'c']);

      const result = await inheritSelectionBatch(db, TRAINER_ID, [
        [makeLink('a', 0), makeLink('deleted', 1), makeLink('c', 2)],
      ]);

      expect(result).toEqual([
        [
          { advancedTechniqueId: 'a', order: 0 },
          { advancedTechniqueId: 'c', order: 1 },
        ],
      ]);
    });

    it('uses a single query across all lists', async () => {
      mockVisibleIds(['a', 'b']);

      await inheritSelectionBatch(db, TRAINER_ID, [[makeLink('a', 0)], [makeLink('a', 0), makeLink('b', 1)]]);

      expect(db.advancedTechnique.findMany).toHaveBeenCalledTimes(1);
    });

    it('returns empty selections without querying when there are no links', async () => {
      const result = await inheritSelectionBatch(db, TRAINER_ID, [[], undefined]);

      expect(result).toEqual([[], []]);
      expect(db.advancedTechnique.findMany).not.toHaveBeenCalled();
    });
  });

  describe('resolveSelectionOrInherit', () => {
    it('uses the explicit ids and ignores the source links', async () => {
      mockVisibleIds(['x']);

      const result = await resolveSelectionOrInherit(db, TRAINER_ID, ['x'], [makeLink('a', 0)]);

      expect(result).toEqual([{ advancedTechniqueId: 'x', order: 0 }]);
    });

    it('keeps an explicit empty list instead of inheriting', async () => {
      const result = await resolveSelectionOrInherit(db, TRAINER_ID, [], [makeLink('a', 0)]);

      expect(result).toEqual([]);
      expect(db.advancedTechnique.findMany).not.toHaveBeenCalled();
    });

    it('rejects explicit ids that are not visible', async () => {
      mockVisibleIds([]);

      await expect(
        resolveSelectionOrInherit(db, TRAINER_ID, ['ghost'], [makeLink('a', 0)]),
      ).rejects.toMatchObject({ statusCode: 400, error: AdvancedTechniqueErrorCode.INVALID_SELECTION });
    });

    it('inherits the visible source links when ids are undefined', async () => {
      mockVisibleIds(['a', 'b']);

      const result = await resolveSelectionOrInherit(db, TRAINER_ID, undefined, [
        makeLink('b', 4),
        makeLink('gone', 6),
        makeLink('a', 1),
      ]);

      expect(result).toEqual([
        { advancedTechniqueId: 'a', order: 0 },
        { advancedTechniqueId: 'b', order: 1 },
      ]);
    });

    it('inherits nothing when ids are undefined and the source has no links', async () => {
      expect(await resolveSelectionOrInherit(db, TRAINER_ID, undefined, undefined)).toEqual([]);
    });
  });
});
