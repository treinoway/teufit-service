import { describe, it, expect, vi } from 'vitest';
import {
  advancedTechniqueLinksInclude,
  toAdvancedTechniqueRefs,
  withAdvancedTechniqueRefs,
  withJunctionTechniqueRefs,
  withTrainingExerciseTechniqueRefs,
  withSessionTechniqueRefs,
  selectionFromLinks,
  toLinkCreateInput,
  replaceAdvancedTechniqueLinks,
} from '../../src/helpers/advanced-technique-refs.js';

// Builds a link row carrying the technique fields exposed to clients.
const makeLink = (id, order, overrides = {}) => ({
  advancedTechniqueId: id,
  order,
  advancedTechnique: {
    id,
    key: `key-${id}`,
    name: `Technique ${id}`,
    description: `Description ${id}`,
    videoUrl: null,
    gifUrl: null,
    deletedAt: null,
    trainerId: null,
  },
  ...overrides,
});

// Builds the public ref expected for a link built by makeLink.
const makeRef = (id, order) => ({
  id,
  key: `key-${id}`,
  name: `Technique ${id}`,
  description: `Description ${id}`,
  videoUrl: null,
  gifUrl: null,
  isDeleted: false,
  order,
});

const VIEWER_ID = 'trainer-viewer';
const OTHER_TRAINER_ID = 'trainer-other';
const REF_KEYS = ['id', 'key', 'name', 'description', 'videoUrl', 'gifUrl', 'isDeleted', 'order'];

// Builds a link whose technique belongs to the given trainer (null = system).
const makeOwnedLink = (id, order, trainerId) => {
  const link = makeLink(id, order);
  link.advancedTechnique.trainerId = trainerId;
  return link;
};

describe('advanced-technique-refs', () => {
  describe('viewer filtering', () => {
    const links = () => [
      makeOwnedLink('own', 0, VIEWER_ID),
      makeOwnedLink('foreign', 1, OTHER_TRAINER_ID),
      makeOwnedLink('system', 2, null),
    ];

    it('drops techniques owned by another trainer and reindexes order from 0', () => {
      const refs = toAdvancedTechniqueRefs(links(), VIEWER_ID);

      expect(refs.map((ref) => [ref.id, ref.order])).toEqual([['own', 0], ['system', 1]]);
    });

    it('keeps system and own techniques for the viewer', () => {
      expect(toAdvancedTechniqueRefs(links(), VIEWER_ID).map((ref) => ref.id)).toEqual(['own', 'system']);
    });

    it('does not filter or reindex when the viewer is undefined', () => {
      const refs = toAdvancedTechniqueRefs(links());

      expect(refs.map((ref) => [ref.id, ref.order])).toEqual([['own', 0], ['foreign', 1], ['system', 2]]);
    });

    it('does not expose trainerId in the output refs', () => {
      const [ref] = toAdvancedTechniqueRefs(links(), VIEWER_ID);

      expect(Object.keys(ref).sort()).toEqual([...REF_KEYS].sort());
    });

    it('returns an empty array for null links with a viewer', () => {
      expect(toAdvancedTechniqueRefs(null, VIEWER_ID)).toEqual([]);
    });

    it('filters withAdvancedTechniqueRefs by viewer', () => {
      const result = withAdvancedTechniqueRefs({ id: 'e', advancedTechniqueLinks: links() }, VIEWER_ID);

      expect(result.advancedTechniques.map((ref) => ref.id)).toEqual(['own', 'system']);
      expect(result).not.toHaveProperty('advancedTechniqueLinks');
    });

    it('filters every junction row by viewer in withJunctionTechniqueRefs', () => {
      const template = { trainingTemplateExerciseTemplates: [{ id: 'j1', advancedTechniqueLinks: links() }] };

      const result = withJunctionTechniqueRefs(template, VIEWER_ID);

      expect(result.trainingTemplateExerciseTemplates[0].advancedTechniques.map((ref) => ref.order)).toEqual([0, 1]);
    });
  });

  describe('advancedTechniqueLinksInclude', () => {
    it('orders links by order ascending and selects only the public technique fields', () => {
      expect(advancedTechniqueLinksInclude.advancedTechniqueLinks.orderBy).toEqual({ order: 'asc' });
      expect(advancedTechniqueLinksInclude.advancedTechniqueLinks.include.advancedTechnique.select).toEqual({
        id: true,
        key: true,
        name: true,
        description: true,
        videoUrl: true,
        gifUrl: true,
        deletedAt: true,
        trainerId: true,
      });
    });
  });

  describe('toAdvancedTechniqueRefs', () => {
    it('maps link rows to refs keeping the link order', () => {
      expect(toAdvancedTechniqueRefs([makeLink('a', 0), makeLink('b', 1)])).toEqual([
        makeRef('a', 0),
        makeRef('b', 1),
      ]);
    });

    it('flags refs of soft-deleted techniques with isDeleted true', () => {
      const link = makeLink('a', 0);
      link.advancedTechnique.deletedAt = new Date('2026-01-01T00:00:00.000Z');
      expect(toAdvancedTechniqueRefs([link])).toEqual([{ ...makeRef('a', 0), isDeleted: true }]);
    });

    it('returns an empty array for null or undefined links', () => {
      expect(toAdvancedTechniqueRefs(null)).toEqual([]);
      expect(toAdvancedTechniqueRefs(undefined)).toEqual([]);
    });
  });

  describe('withAdvancedTechniqueRefs', () => {
    it('replaces advancedTechniqueLinks with advancedTechniques', () => {
      const entity = { id: 'ex1', name: 'Squat', advancedTechniqueLinks: [makeLink('a', 0)] };

      const result = withAdvancedTechniqueRefs(entity);

      expect(result).toEqual({ id: 'ex1', name: 'Squat', advancedTechniques: [makeRef('a', 0)] });
      expect(result).not.toHaveProperty('advancedTechniqueLinks');
    });

    it('returns an empty advancedTechniques array when the loaded links are empty', () => {
      expect(withAdvancedTechniqueRefs({ id: 'ex1', advancedTechniqueLinks: [] })).toEqual({
        id: 'ex1',
        advancedTechniques: [],
      });
    });

    it('returns the entity untouched when the links key is absent', () => {
      const entity = { id: 'ex1', name: 'Squat' };

      expect(withAdvancedTechniqueRefs(entity)).toBe(entity);
    });

    it('returns null and undefined as they are', () => {
      expect(withAdvancedTechniqueRefs(null)).toBeNull();
      expect(withAdvancedTechniqueRefs(undefined)).toBeUndefined();
    });

    it('does not touch nested substitutes that carry their own links', () => {
      const substitute = { id: 'sub1', advancedTechniqueLinks: [makeLink('b', 0)] };
      const entity = { id: 'ex1', advancedTechniqueLinks: [makeLink('a', 0)], substitutes: [substitute] };

      const result = withAdvancedTechniqueRefs(entity);

      expect(result.substitutes).toEqual([substitute]);
      expect(result.substitutes[0]).toBe(substitute);
    });
  });

  describe('withJunctionTechniqueRefs', () => {
    it('maps the links of every junction row', () => {
      const template = {
        id: 'tpl1',
        trainingTemplateExerciseTemplates: [
          { id: 'j1', advancedTechniqueLinks: [makeLink('a', 0)] },
          { id: 'j2', advancedTechniqueLinks: [] },
        ],
      };

      expect(withJunctionTechniqueRefs(template)).toEqual({
        id: 'tpl1',
        trainingTemplateExerciseTemplates: [
          { id: 'j1', advancedTechniques: [makeRef('a', 0)] },
          { id: 'j2', advancedTechniques: [] },
        ],
      });
    });

    it('returns the template untouched when junction rows are not loaded', () => {
      const template = { id: 'tpl1' };

      expect(withJunctionTechniqueRefs(template)).toBe(template);
    });

    it('returns null as it is', () => {
      expect(withJunctionTechniqueRefs(null)).toBeNull();
    });
  });

  describe('withTrainingExerciseTechniqueRefs', () => {
    it('maps the links of every exercise of the training', () => {
      const training = {
        id: 'tr1',
        exercises: [{ id: 'ex1', advancedTechniqueLinks: [makeLink('a', 0)] }],
      };

      expect(withTrainingExerciseTechniqueRefs(training)).toEqual({
        id: 'tr1',
        exercises: [{ id: 'ex1', advancedTechniques: [makeRef('a', 0)] }],
      });
    });

    it('returns the training untouched when exercises are not loaded', () => {
      const training = { id: 'tr1' };

      expect(withTrainingExerciseTechniqueRefs(training)).toBe(training);
    });

    it('returns null as it is', () => {
      expect(withTrainingExerciseTechniqueRefs(null)).toBeNull();
    });
  });

  describe('withSessionTechniqueRefs', () => {
    it('maps the links of the exercise of every exercise log', () => {
      const session = {
        id: 's1',
        exerciseLogs: [
          { id: 'log1', exercise: { id: 'ex1', advancedTechniqueLinks: [makeLink('a', 0)] } },
          { id: 'log2', exercise: { id: 'ex2', advancedTechniqueLinks: [] } },
        ],
      };

      expect(withSessionTechniqueRefs(session)).toEqual({
        id: 's1',
        exerciseLogs: [
          { id: 'log1', exercise: { id: 'ex1', advancedTechniques: [makeRef('a', 0)] } },
          { id: 'log2', exercise: { id: 'ex2', advancedTechniques: [] } },
        ],
      });
    });

    it('keeps a log whose exercise is missing', () => {
      const session = { id: 's1', exerciseLogs: [{ id: 'log1', exercise: null }] };

      expect(withSessionTechniqueRefs(session).exerciseLogs).toEqual([{ id: 'log1', exercise: null }]);
    });

    it('returns the session untouched when exercise logs are not loaded', () => {
      const session = { id: 's1' };

      expect(withSessionTechniqueRefs(session)).toBe(session);
    });
  });

  describe('selectionFromLinks', () => {
    it('sorts by order and re-indexes from zero', () => {
      const links = [makeLink('c', 7), makeLink('a', 2), makeLink('b', 5)];

      expect(selectionFromLinks(links)).toEqual([
        { advancedTechniqueId: 'a', order: 0 },
        { advancedTechniqueId: 'b', order: 1 },
        { advancedTechniqueId: 'c', order: 2 },
      ]);
    });

    it('does not mutate the input array', () => {
      const links = [makeLink('b', 1), makeLink('a', 0)];

      selectionFromLinks(links);

      expect(links.map((link) => link.advancedTechniqueId)).toEqual(['b', 'a']);
    });

    it('returns an empty array for null or undefined links', () => {
      expect(selectionFromLinks(null)).toEqual([]);
      expect(selectionFromLinks(undefined)).toEqual([]);
    });
  });

  describe('toLinkCreateInput', () => {
    it('wraps the selection in a nested create', () => {
      const selection = [{ advancedTechniqueId: 'a', order: 0 }];

      expect(toLinkCreateInput(selection)).toEqual({ advancedTechniqueLinks: { create: selection } });
    });

    it('returns an empty object when the selection is empty or missing', () => {
      expect(toLinkCreateInput([])).toEqual({});
      expect(toLinkCreateInput(undefined)).toEqual({});
    });
  });

  describe('replaceAdvancedTechniqueLinks', () => {
    const PARENT_FIELD = 'exerciseId';
    const PARENT_ID = 'ex1';

    it('deletes the existing links then creates the new ones tagged with the parent id', async () => {
      const callOrder = [];
      const linkDelegate = {
        deleteMany: vi.fn().mockImplementation(async () => callOrder.push('deleteMany')),
        createMany: vi.fn().mockImplementation(async () => callOrder.push('createMany')),
      };
      const selection = [
        { advancedTechniqueId: 'a', order: 0 },
        { advancedTechniqueId: 'b', order: 1 },
      ];

      await replaceAdvancedTechniqueLinks(linkDelegate, PARENT_FIELD, PARENT_ID, selection);

      expect(linkDelegate.deleteMany).toHaveBeenCalledWith({ where: { exerciseId: PARENT_ID } });
      expect(linkDelegate.createMany).toHaveBeenCalledWith({
        data: [
          { advancedTechniqueId: 'a', order: 0, exerciseId: PARENT_ID },
          { advancedTechniqueId: 'b', order: 1, exerciseId: PARENT_ID },
        ],
      });
      expect(callOrder).toEqual(['deleteMany', 'createMany']);
    });

    it('only deletes when the selection is empty', async () => {
      const linkDelegate = { deleteMany: vi.fn().mockResolvedValue({}), createMany: vi.fn() };

      await replaceAdvancedTechniqueLinks(linkDelegate, PARENT_FIELD, PARENT_ID, []);

      expect(linkDelegate.deleteMany).toHaveBeenCalledTimes(1);
      expect(linkDelegate.createMany).not.toHaveBeenCalled();
    });
  });
});
