import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { prisma } from '../../src/db.js';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { provisionTrainerPlan } from '../helpers/platform-plan.js';
import { signupVerified } from '../helpers/signup-user.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

const PASSWORD = 'StrongPassw0rd!';
const EDITED_NAME = 'Minha rotina editada';

e2eDescribe('e2e: editing the seeded example routine', () => {
  let app;
  let emailSeq = 0;

  beforeAll(async () => {
    app = await setupApp();
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  const auth = (token) => ({ authorization: `Bearer ${token}` });

  async function createTrainer() {
    emailSeq += 1;
    const email = `e2e+edit-example-${Date.now()}-${emailSeq}@example.com`;
    const signup = await signupVerified(app, {
      method: 'POST',
      url: '/auth/signup',
      payload: { email, password: PASSWORD },
    });
    expect(signup.statusCode).toBe(201);
    const { user: { id: userId }, token: { accessToken: studentToken } } = signup.json();
    const becomeRes = await app.inject({ method: 'PATCH', url: '/become-trainer', headers: auth(studentToken) });
    expect(becomeRes.statusCode).toBe(200);
    const trainer = await prisma.trainer.findUnique({ where: { userId }, select: { id: true } });
    await provisionTrainerPlan(trainer.id);
    return { trainerId: trainer.id, accessToken: becomeRes.json().token.accessToken };
  }

  async function createTrainerWithExampleRoutine() {
    const owner = await createTrainer();
    await prisma.exerciseTemplate.createMany({
      data: [
        { trainerId: owner.trainerId, name: 'Agachamento livre', type: 'strength', isPublic: true },
        { trainerId: owner.trainerId, name: 'Supino reto', type: 'strength', isPublic: true },
      ],
    });
    return createTrainer();
  }

  async function listProtocolTemplates(accessToken) {
    const res = await app.inject({ method: 'GET', url: '/trainer/protocol-templates', headers: auth(accessToken) });
    expect(res.statusCode).toBe(200);
    return res.json().data;
  }

  async function listOwnTrainingTemplates(accessToken) {
    const res = await app.inject({ method: 'GET', url: '/trainer/training-templates', headers: auth(accessToken) });
    expect(res.statusCode).toBe(200);
    return res.json().data;
  }

  function patchProtocolTemplate(accessToken, id, payload) {
    return app.inject({
      method: 'PATCH',
      url: `/trainer/protocol-templates/${id}`,
      headers: auth(accessToken),
      payload,
    });
  }

  it('hides the example training from the training-templates list before the routine is edited', async () => {
    const trainer = await createTrainerWithExampleRoutine();

    const trainings = await listOwnTrainingTemplates(trainer.accessToken);

    expect(trainings.filter((training) => training.trainerId === trainer.trainerId)).toEqual([]);
  });

  it('clears isExample on the routine when the trainer renames it', async () => {
    const trainer = await createTrainerWithExampleRoutine();
    const [example] = await listProtocolTemplates(trainer.accessToken);
    expect(example.isExample).toBe(true);

    const res = await patchProtocolTemplate(trainer.accessToken, example.id, { name: EDITED_NAME });

    expect(res.statusCode).toBe(200);
    expect(res.json().isExample).toBe(false);
    const persisted = await prisma.trainingProtocolTemplate.findUnique({ where: { id: example.id } });
    expect(persisted).toMatchObject({ name: EDITED_NAME, isExample: false });
  });

  it('clears isExample on the linked example training and lists it in the training-templates list', async () => {
    const trainer = await createTrainerWithExampleRoutine();
    const [example] = await listProtocolTemplates(trainer.accessToken);
    const link = await prisma.protocolTemplateTraining.findFirst({ where: { protocolTemplateId: example.id } });

    await patchProtocolTemplate(trainer.accessToken, example.id, { name: EDITED_NAME });

    const training = await prisma.trainingTemplate.findUnique({ where: { id: link.trainingTemplateId } });
    expect(training.isExample).toBe(false);
    const listed = await listOwnTrainingTemplates(trainer.accessToken);
    expect(listed.map((item) => item.id)).toContain(link.trainingTemplateId);
  });

  it('does not touch the example flags of another trainer', async () => {
    const trainer = await createTrainerWithExampleRoutine();
    const other = await createTrainer();
    const [example] = await listProtocolTemplates(trainer.accessToken);
    const otherExample = await prisma.trainingTemplate.create({
      data: { trainerId: other.trainerId, name: 'Outro exemplo', category: 'strength', isExample: true },
    });

    await patchProtocolTemplate(trainer.accessToken, example.id, { name: EDITED_NAME });

    const untouched = await prisma.trainingTemplate.findUnique({ where: { id: otherExample.id } });
    expect(untouched.isExample).toBe(true);
  });

  it('keeps isExample false on a regular routine after an edit', async () => {
    const trainer = await createTrainer();
    const createRes = await app.inject({
      method: 'POST',
      url: '/trainer/protocol-templates',
      headers: auth(trainer.accessToken),
      payload: { name: 'Rotina comum' },
    });
    expect(createRes.statusCode).toBe(201);

    const res = await patchProtocolTemplate(trainer.accessToken, createRes.json().id, { name: EDITED_NAME });

    expect(res.statusCode).toBe(200);
    expect(res.json().isExample).toBe(false);
  });
});
