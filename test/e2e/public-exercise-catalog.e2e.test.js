import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import {
  importPublicExerciseCatalog,
  catalogTemplateId,
} from '../../scripts/lib/public-exercise-catalog.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

const ID_A = 'xdEZIvUOoPE';
const ID_B = 'AAAAAAAAAAA';

const catalog = {
  entries: [
    { youtubeId: ID_A, title: 'Remada Baixa Pegada Supinada', name: 'Remada baixa pegada supinada', type: 'strength' },
    { youtubeId: ID_B, title: 'Alongamento de Posterior', name: 'Alongamento de posterior', type: 'stretching' },
  ],
};

e2eDescribe('e2e: public exercise catalog import', () => {
  let app;
  let prisma;

  beforeAll(async () => {
    app = await setupApp();
    ({ prisma } = await import('../../src/db.js'));
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  async function createTrainer(label) {
    const email = `e2e+catalog-${label}-${Date.now()}@example.com`;
    const signup = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { email, password: 'StrongPassw0rd!' },
    });
    expect(signup.statusCode).toBe(201);
    const become = await app.inject({
      method: 'PATCH',
      url: '/become-trainer',
      headers: { authorization: `Bearer ${signup.json().token.accessToken}` },
    });
    expect(become.statusCode).toBe(200);
    return { email, token: become.json().token.accessToken };
  }

  async function listPublic(token) {
    const response = await app.inject({
      method: 'GET',
      url: '/trainer/exercise-templates/public',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    return response.json();
  }

  it('makes the catalog visible to other trainers as public templates', async () => {
    const owner = await createTrainer('owner');
    const otherTrainer = await createTrainer('other');

    const report = await importPublicExerciseCatalog(prisma, {
      catalog,
      ownerEmail: owner.email,
      apply: true,
    });
    expect(report.created).toBe(2);

    const templates = await listPublic(otherTrainer.token);
    const imported = templates.filter((template) =>
      [catalogTemplateId(ID_A), catalogTemplateId(ID_B)].includes(template.id),
    );
    expect(imported).toHaveLength(2);
    expect(imported.find((template) => template.id === catalogTemplateId(ID_A))).toMatchObject({
      name: 'Remada baixa pegada supinada',
      type: 'strength',
      videoUrl: 'https://www.youtube.com/watch?v=xdEZIvUOoPE',
      isPublic: true,
    });
  });

  it('dry-run writes nothing', async () => {
    const owner = await createTrainer('dry');

    const report = await importPublicExerciseCatalog(prisma, { catalog, ownerEmail: owner.email });

    expect(report.create).toHaveLength(2);
    expect(await prisma.exerciseTemplate.count({ where: { isPublic: true } })).toBe(0);
  });

  it('is idempotent and keeps a template deleted in the app deleted', async () => {
    const owner = await createTrainer('idem');
    await importPublicExerciseCatalog(prisma, { catalog, ownerEmail: owner.email, apply: true });

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/trainer/exercise-templates/${catalogTemplateId(ID_B)}`,
      headers: { authorization: `Bearer ${owner.token}` },
    });
    expect(deleted.statusCode).toBeLessThan(300);

    const second = await importPublicExerciseCatalog(prisma, {
      catalog,
      ownerEmail: owner.email,
      apply: true,
    });

    expect(second.created).toBe(0);
    expect(second.existing.map((item) => item.youtubeId)).toEqual([ID_A]);
    expect(second.deleted.map((item) => item.youtubeId)).toEqual([ID_B]);
    expect(await prisma.exerciseTemplate.count()).toBe(2);
  });
});
