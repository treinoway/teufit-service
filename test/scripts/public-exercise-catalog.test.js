import { describe, it, expect, vi } from 'vitest';
import {
  parseYoutubeId,
  youtubeWatchUrl,
  catalogTemplateId,
  mergeCatalog,
  validateCatalog,
  importPublicExerciseCatalog,
  CATALOG_SOURCE,
} from '../../scripts/lib/public-exercise-catalog.js';

const ID_A = 'xdEZIvUOoPE';
const ID_B = 'AAAAAAAAAAA';
const ID_C = 'BBBBBBBBBBB';

describe('parseYoutubeId', () => {
  it.each([
    ['https://www.youtube.com/shorts/xdEZIvUOoPE', ID_A],
    ['https://youtube.com/shorts/xdEZIvUOoPE?feature=share', ID_A],
    ['https://www.youtube.com/watch?v=xdEZIvUOoPE', ID_A],
    ['https://www.youtube.com/watch?list=PL1&v=xdEZIvUOoPE', ID_A],
    ['https://youtu.be/xdEZIvUOoPE', ID_A],
    ['https://www.youtube.com/embed/xdEZIvUOoPE', ID_A],
    ['  xdEZIvUOoPE  ', ID_A],
  ])('extracts the id from %s', (input, expected) => {
    expect(parseYoutubeId(input)).toBe(expected);
  });

  it.each(['https://example.com/watch?v=xdEZIvUOoPE', 'short', '', null, undefined])(
    'rejects %s',
    (input) => {
      expect(parseYoutubeId(input)).toBeNull();
    },
  );
});

describe('catalogTemplateId', () => {
  it('is deterministic and a valid v5-style UUID', () => {
    const id = catalogTemplateId(ID_A);
    expect(id).toBe(catalogTemplateId(ID_A));
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('differs per video', () => {
    expect(catalogTemplateId(ID_A)).not.toBe(catalogTemplateId(ID_B));
  });
});

describe('youtubeWatchUrl', () => {
  it('builds the canonical watch URL', () => {
    expect(youtubeWatchUrl(ID_A)).toBe('https://www.youtube.com/watch?v=xdEZIvUOoPE');
  });
});

describe('mergeCatalog', () => {
  it('normalizes the name and infers the type of new videos', () => {
    const { catalog, added } = mergeCatalog(null, [
      { youtubeId: ID_A, title: 'Remada Baixa Pegada Supinada' },
      { youtubeId: ID_B, title: 'Alongamento de Posterior' },
    ]);

    expect(added).toBe(2);
    expect(catalog.source).toBe(CATALOG_SOURCE);
    expect(catalog.entries).toEqual([
      {
        youtubeId: ID_B,
        title: 'Alongamento de Posterior',
        name: 'Alongamento de posterior',
        type: 'stretching',
      },
      {
        youtubeId: ID_A,
        title: 'Remada Baixa Pegada Supinada',
        name: 'Remada baixa pegada supinada',
        type: 'strength',
      },
    ]);
  });

  it('keeps hand-edited name and type, refreshing only the raw title', () => {
    const existing = {
      entries: [{ youtubeId: ID_A, title: 'Old title', name: 'Remada baixa (supinada)', type: 'mobility' }],
    };

    const { catalog, added, updated } = mergeCatalog(existing, [
      { youtubeId: ID_A, title: 'Remada Baixa Pegada Supinada' },
    ]);

    expect(added).toBe(0);
    expect(updated).toBe(1);
    expect(catalog.entries[0]).toEqual({
      youtubeId: ID_A,
      title: 'Remada Baixa Pegada Supinada',
      name: 'Remada baixa (supinada)',
      type: 'mobility',
    });
  });

  it('keeps entries that were not fetched this time', () => {
    const existing = { entries: [{ youtubeId: ID_A, title: 'A', name: 'A', type: 'strength' }] };

    const { catalog } = mergeCatalog(existing, [{ youtubeId: ID_B, title: 'B' }]);

    expect(catalog.entries.map((entry) => entry.youtubeId)).toEqual([ID_A, ID_B]);
  });

  it('does not mutate the existing catalog', () => {
    const existing = { entries: [{ youtubeId: ID_A, title: 'Old', name: 'A', type: 'strength' }] };

    mergeCatalog(existing, [{ youtubeId: ID_A, title: 'New' }]);

    expect(existing.entries[0].title).toBe('Old');
  });
});

describe('validateCatalog', () => {
  it('accepts a valid catalog', () => {
    expect(
      validateCatalog({ entries: [{ youtubeId: ID_A, name: 'Remada', type: 'strength' }] }),
    ).toEqual([]);
  });

  it('reports every invalid entry', () => {
    const problems = validateCatalog({
      entries: [
        { youtubeId: 'bad', name: 'A', type: 'strength' },
        { youtubeId: ID_A, name: ' ', type: 'strength' },
        { youtubeId: ID_B, name: 'B', type: 'yoga' },
        { youtubeId: ID_B, name: 'B2', type: 'strength' },
      ],
    });

    expect(problems).toHaveLength(4);
    expect(problems.join('\n')).toMatch(/invalid youtubeId "bad"/);
    expect(problems.join('\n')).toMatch(/name is required/);
    expect(problems.join('\n')).toMatch(/invalid type "yoga"/);
    expect(problems.join('\n')).toMatch(/duplicated youtubeId/);
  });

  it('rejects a catalog without entries', () => {
    expect(validateCatalog({})).toHaveLength(1);
    expect(validateCatalog(null)).toHaveLength(1);
  });
});

describe('importPublicExerciseCatalog', () => {
  const OWNER_EMAIL = 'catalogo@teufit.com';
  const TRAINER_ID = 'trainer-1';

  function entry(youtubeId, name, type = 'strength') {
    return { youtubeId, title: name, name, type };
  }

  function mockPrisma({
    owner = { id: 'user-1', deletedAt: null, trainer: { id: TRAINER_ID, deletedAt: null } },
    rowsById = [],
    ownerTemplates = [],
    otherPublicTemplates = [],
  } = {}) {
    const findMany = vi.fn(async ({ where }) => {
      if (where.id) return rowsById;
      if (where.trainerId === TRAINER_ID) return ownerTemplates;
      return otherPublicTemplates;
    });
    return {
      user: { findUnique: vi.fn(async () => owner) },
      exerciseTemplate: {
        findMany,
        createMany: vi.fn(async ({ data }) => ({ count: data.length })),
      },
    };
  }

  it('dry-run reports what would be created and writes nothing', async () => {
    const prisma = mockPrisma();
    const catalog = { entries: [entry(ID_A, 'Remada baixa pegada supinada')] };

    const report = await importPublicExerciseCatalog(prisma, { catalog, ownerEmail: OWNER_EMAIL });

    expect(report.apply).toBe(false);
    expect(report.create).toEqual([
      expect.objectContaining({ youtubeId: ID_A, id: catalogTemplateId(ID_A) }),
    ]);
    expect(report.created).toBe(0);
    expect(prisma.exerciseTemplate.createMany).not.toHaveBeenCalled();
  });

  it('apply creates public templates owned by the trainer with the YouTube URL', async () => {
    const prisma = mockPrisma();
    const catalog = { entries: [entry(ID_A, '  Remada baixa pegada supinada  ')] };

    const report = await importPublicExerciseCatalog(prisma, {
      catalog,
      ownerEmail: OWNER_EMAIL,
      apply: true,
    });

    expect(report.created).toBe(1);
    expect(prisma.exerciseTemplate.createMany).toHaveBeenCalledWith({
      data: [
        {
          id: catalogTemplateId(ID_A),
          trainerId: TRAINER_ID,
          name: 'Remada baixa pegada supinada',
          type: 'strength',
          videoUrl: 'https://www.youtube.com/watch?v=xdEZIvUOoPE',
          isPublic: true,
        },
      ],
      skipDuplicates: true,
    });
  });

  it('looks the owner up by trimmed, lower-cased email', async () => {
    const prisma = mockPrisma();

    await importPublicExerciseCatalog(prisma, {
      catalog: { entries: [] },
      ownerEmail: '  Catalogo@TeuFit.com ',
    });

    expect(prisma.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { email: OWNER_EMAIL } }),
    );
  });

  it('leaves rows that already exist untouched and keeps deleted ones deleted', async () => {
    const prisma = mockPrisma({
      rowsById: [
        { id: catalogTemplateId(ID_A), deletedAt: null },
        { id: catalogTemplateId(ID_B), deletedAt: new Date() },
      ],
    });
    const catalog = { entries: [entry(ID_A, 'Remada'), entry(ID_B, 'Supino')] };

    const report = await importPublicExerciseCatalog(prisma, {
      catalog,
      ownerEmail: OWNER_EMAIL,
      apply: true,
    });

    expect(report.existing.map((item) => item.youtubeId)).toEqual([ID_A]);
    expect(report.deleted.map((item) => item.youtubeId)).toEqual([ID_B]);
    expect(report.create).toEqual([]);
    expect(prisma.exerciseTemplate.createMany).not.toHaveBeenCalled();
  });

  it('skips near-duplicates inside the catalog', async () => {
    const prisma = mockPrisma();
    const catalog = { entries: [entry(ID_A, 'Leg press 45'), entry(ID_B, 'Leg press 45º')] };

    const report = await importPublicExerciseCatalog(prisma, { catalog, ownerEmail: OWNER_EMAIL });

    expect(report.create.map((item) => item.youtubeId)).toEqual([ID_A]);
    expect(report.duplicateInCatalog.map((item) => item.youtubeId)).toEqual([ID_B]);
  });

  it('treats the same name with a different type as a different exercise', async () => {
    const prisma = mockPrisma();
    const catalog = {
      entries: [entry(ID_A, 'Prancha', 'strength'), entry(ID_B, 'Prancha', 'mobility')],
    };

    const report = await importPublicExerciseCatalog(prisma, { catalog, ownerEmail: OWNER_EMAIL });

    expect(report.create).toHaveLength(2);
  });

  it("skips exercises the owner already has and only warns about other trainers' ones", async () => {
    const prisma = mockPrisma({
      ownerTemplates: [{ id: 'mine', name: 'Supino reto', type: 'strength' }],
      otherPublicTemplates: [{ name: 'Agachamento livre', type: 'strength' }],
    });
    const catalog = {
      entries: [
        entry(ID_A, 'Supino Reto'),
        entry(ID_B, 'Agachamento livre'),
        entry(ID_C, 'Remada'),
      ],
    };

    const report = await importPublicExerciseCatalog(prisma, { catalog, ownerEmail: OWNER_EMAIL });

    expect(report.duplicateOfOwner).toEqual([
      expect.objectContaining({ youtubeId: ID_A, existingTemplateId: 'mine' }),
    ]);
    expect(report.create.map((item) => item.youtubeId)).toEqual([ID_B, ID_C]);
    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0]).toMatch(/Agachamento livre/);
  });

  it('fails when the owner does not exist', async () => {
    const prisma = mockPrisma({ owner: null });

    await expect(
      importPublicExerciseCatalog(prisma, { catalog: { entries: [] }, ownerEmail: OWNER_EMAIL }),
    ).rejects.toThrow(/No active user/);
  });

  it('fails when the owner is deleted', async () => {
    const prisma = mockPrisma({
      owner: { id: 'u', deletedAt: new Date(), trainer: { id: TRAINER_ID, deletedAt: null } },
    });

    await expect(
      importPublicExerciseCatalog(prisma, { catalog: { entries: [] }, ownerEmail: OWNER_EMAIL }),
    ).rejects.toThrow(/No active user/);
  });

  it('fails when the owner has no active trainer profile', async () => {
    const prisma = mockPrisma({ owner: { id: 'u', deletedAt: null, trainer: null } });

    await expect(
      importPublicExerciseCatalog(prisma, { catalog: { entries: [] }, ownerEmail: OWNER_EMAIL }),
    ).rejects.toThrow(/no active trainer profile/);
  });

  it('fails without an owner email', async () => {
    await expect(
      importPublicExerciseCatalog(mockPrisma(), { catalog: { entries: [] }, ownerEmail: ' ' }),
    ).rejects.toThrow(/ownerEmail is required/);
  });

  it('validates the catalog before querying the database', async () => {
    const prisma = mockPrisma();

    await expect(
      importPublicExerciseCatalog(prisma, {
        catalog: { entries: [entry(ID_A, 'Remada', 'yoga')] },
        ownerEmail: OWNER_EMAIL,
      }),
    ).rejects.toThrow(/Invalid catalog/);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });
});
