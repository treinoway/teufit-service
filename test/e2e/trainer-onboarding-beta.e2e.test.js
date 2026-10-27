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
const BRANDING_COLOR = '#FF5733';

e2eDescribe('e2e: trainer onboarding beta milestones', () => {
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

  async function createUser(prefix) {
    emailSeq += 1;
    const email = `e2e+${prefix}-${Date.now()}-${emailSeq}@example.com`;
    const res = await signupVerified(app, {
      method: 'POST',
      url: '/auth/signup',
      payload: { email, password: PASSWORD },
    });
    expect(res.statusCode).toBe(201);
    const { user: { id: userId }, token: { accessToken } } = res.json();
    return { userId, email, accessToken };
  }

  async function createTrainer() {
    const user = await createUser('trainer');
    const becomeRes = await app.inject({
      method: 'PATCH',
      url: '/become-trainer',
      headers: auth(user.accessToken),
    });
    expect(becomeRes.statusCode).toBe(200);
    const accessToken = becomeRes.json().token.accessToken;
    const trainer = await prisma.trainer.findUnique({ where: { userId: user.userId }, select: { id: true } });
    await provisionTrainerPlan(trainer.id);
    return { ...user, accessToken, trainerId: trainer.id };
  }

  async function getOnboarding(accessToken) {
    const res = await app.inject({
      method: 'GET',
      url: '/me?include=trainerOnboarding',
      headers: auth(accessToken),
    });
    expect(res.statusCode).toBe(200);
    return res.json().trainerOnboarding;
  }

  function setTrainerNames(accessToken, firstName, lastName) {
    return app.inject({
      method: 'PATCH',
      url: '/trainer',
      headers: auth(accessToken),
      payload: { trainer: { firstName, lastName } },
    });
  }

  async function uploadAvatar(accessToken) {
    const boundary = '----BetaOnboardingBoundary';
    const payload = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="avatar.jpg"',
      'Content-Type: image/jpeg',
      '',
      Buffer.from('fake-jpeg-data').toString('binary'),
      `--${boundary}--`,
    ].join('\r\n');
    const res = await app.inject({
      method: 'POST',
      url: '/me/avatar',
      headers: { ...auth(accessToken), 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });
    expect(res.statusCode).toBe(200);
  }

  function inviteStudent(accessToken, email) {
    return app.inject({
      method: 'POST',
      url: '/trainer/student-invites',
      headers: auth(accessToken),
      payload: { email },
    });
  }

  async function listProtocolTemplates(accessToken) {
    const res = await app.inject({
      method: 'GET',
      url: '/trainer/protocol-templates',
      headers: auth(accessToken),
    });
    expect(res.statusCode).toBe(200);
    return res.json().data;
  }


  describe('profile milestone (firstName + lastName + avatar)', () => {
    it('sets profileCompleted when name and avatar are present without birthDate, gender or address', async () => {
      const trainer = await createTrainer();

      await setTrainerNames(trainer.accessToken, 'Ana', 'Silva');
      await uploadAvatar(trainer.accessToken);

      const onboarding = await getOnboarding(trainer.accessToken);
      expect(onboarding.profileCompleted).toBe(true);
      expect(typeof onboarding.profileCompletedAt).toBe('string');
    });

    it('sets profileCompleted when the avatar is uploaded before the names are saved', async () => {
      const trainer = await createTrainer();

      await uploadAvatar(trainer.accessToken);
      expect((await getOnboarding(trainer.accessToken)).profileCompleted).toBe(false);

      await setTrainerNames(trainer.accessToken, 'Ana', 'Silva');

      expect((await getOnboarding(trainer.accessToken)).profileCompleted).toBe(true);
    });

    it('keeps profileCompleted false when only name is set (no avatar)', async () => {
      const trainer = await createTrainer();

      await setTrainerNames(trainer.accessToken, 'Ana', 'Silva');

      expect((await getOnboarding(trainer.accessToken)).profileCompleted).toBe(false);
    });

    it('keeps profileCompleted false when only the avatar is set (no name)', async () => {
      const trainer = await createTrainer();

      await uploadAvatar(trainer.accessToken);

      expect((await getOnboarding(trainer.accessToken)).profileCompleted).toBe(false);
    });
  });


  it('returns the new milestones as null/false for a freshly created trainer', async () => {
    const trainer = await createTrainer();

    const onboarding = await getOnboarding(trainer.accessToken);

    expect(onboarding).toMatchObject({
      firstStudentInvitedAt: null,
      firstStudentInvited: false,
      firstAnamnesisSentAt: null,
      firstAnamnesisSent: false,
      brandingConfiguredAt: null,
      brandingConfigured: false,
    });
  });


  describe('first student invite milestone', () => {
    it('sets firstStudentInvitedAt and firstStudentInvited after the first invite', async () => {
      const trainer = await createTrainer();

      const res = await inviteStudent(trainer.accessToken, 'invited.one@example.com');
      expect(res.statusCode).toBe(201);

      const onboarding = await getOnboarding(trainer.accessToken);
      expect(onboarding.firstStudentInvited).toBe(true);
      expect(typeof onboarding.firstStudentInvitedAt).toBe('string');
      expect(onboarding.firstStudentLinked).toBe(false);
    });

    it('keeps firstStudentInvitedAt unchanged when a second student is invited', async () => {
      const trainer = await createTrainer();
      await inviteStudent(trainer.accessToken, 'invited.one@example.com');
      const first = (await getOnboarding(trainer.accessToken)).firstStudentInvitedAt;
      expect(typeof first).toBe('string');

      await inviteStudent(trainer.accessToken, 'invited.two@example.com');

      expect((await getOnboarding(trainer.accessToken)).firstStudentInvitedAt).toBe(first);
    });
  });


  describe('first anamnesis sent milestone', () => {
    async function linkStudent(trainer) {
      const student = await createUser('student');
      const res = await app.inject({
        method: 'POST',
        url: '/trainer/students',
        headers: auth(trainer.accessToken),
        payload: { email: student.email },
      });
      expect(res.statusCode).toBe(201);
      return student;
    }

    async function createAnamnesis(accessToken, title) {
      const res = await app.inject({
        method: 'POST',
        url: '/trainer/anamneses',
        headers: auth(accessToken),
        payload: { title },
      });
      expect(res.statusCode).toBe(201);
      return res.json().id;
    }

    function assignAnamnesis(accessToken, studentId, anamnesisId) {
      return app.inject({
        method: 'POST',
        url: `/trainer/students/${studentId}/anamneses`,
        headers: auth(accessToken),
        payload: { anamnesisId },
      });
    }

    it('sets firstAnamnesisSentAt and firstAnamnesisSent after assigning an anamnesis to a student', async () => {
      const trainer = await createTrainer();
      const student = await linkStudent(trainer);
      const anamnesisId = await createAnamnesis(trainer.accessToken, 'Anamnese inicial');

      const res = await assignAnamnesis(trainer.accessToken, student.userId, anamnesisId);
      expect(res.statusCode).toBe(201);

      const onboarding = await getOnboarding(trainer.accessToken);
      expect(onboarding.firstAnamnesisSent).toBe(true);
      expect(typeof onboarding.firstAnamnesisSentAt).toBe('string');
    });

    it('keeps firstAnamnesisSentAt unchanged when a second anamnesis is assigned', async () => {
      const trainer = await createTrainer();
      const student = await linkStudent(trainer);
      const firstId = await createAnamnesis(trainer.accessToken, 'Anamnese A');
      const secondId = await createAnamnesis(trainer.accessToken, 'Anamnese B');
      await assignAnamnesis(trainer.accessToken, student.userId, firstId);
      const first = (await getOnboarding(trainer.accessToken)).firstAnamnesisSentAt;
      expect(typeof first).toBe('string');

      await assignAnamnesis(trainer.accessToken, student.userId, secondId);

      expect((await getOnboarding(trainer.accessToken)).firstAnamnesisSentAt).toBe(first);
    });

    it('does not set the milestone when creating an anamnesis without assigning it', async () => {
      const trainer = await createTrainer();

      await createAnamnesis(trainer.accessToken, 'Anamnese rascunho');

      expect((await getOnboarding(trainer.accessToken)).firstAnamnesisSent).toBe(false);
    });
  });


  describe('branding configured milestone', () => {
    function saveBranding(accessToken, primaryColor) {
      return app.inject({
        method: 'PUT',
        url: '/trainer/branding',
        headers: auth(accessToken),
        payload: { primaryColor },
      });
    }

    it('sets brandingConfiguredAt and brandingConfigured on the first branding save', async () => {
      const trainer = await createTrainer();

      const res = await saveBranding(trainer.accessToken, BRANDING_COLOR);
      expect(res.statusCode).toBe(200);

      const onboarding = await getOnboarding(trainer.accessToken);
      expect(onboarding.brandingConfigured).toBe(true);
      expect(typeof onboarding.brandingConfiguredAt).toBe('string');
    });

    it('keeps brandingConfiguredAt unchanged on later branding saves', async () => {
      const trainer = await createTrainer();
      await saveBranding(trainer.accessToken, BRANDING_COLOR);
      const first = (await getOnboarding(trainer.accessToken)).brandingConfiguredAt;
      expect(typeof first).toBe('string');

      await saveBranding(trainer.accessToken, '#123456');

      expect((await getOnboarding(trainer.accessToken)).brandingConfiguredAt).toBe(first);
    });

    it('does not set the milestone when the branding save is rejected', async () => {
      const trainer = await createTrainer();

      const res = await saveBranding(trainer.accessToken, 'not-a-color');
      expect(res.statusCode).toBe(400);

      expect((await getOnboarding(trainer.accessToken)).brandingConfigured).toBe(false);
    });
  });


  describe('example routine seeding', () => {
    async function seedPublicExerciseTemplates(ownerTrainerId) {
      await prisma.exerciseTemplate.createMany({
        data: [
          { trainerId: ownerTrainerId, name: 'Agachamento livre', type: 'strength', isPublic: true },
          { trainerId: ownerTrainerId, name: 'Supino reto', type: 'strength', isPublic: true },
        ],
      });
    }

    it('seeds one isExample protocol template for a new trainer when public exercise templates exist', async () => {
      const owner = await createTrainer();
      await seedPublicExerciseTemplates(owner.trainerId);

      const trainer = await createTrainer();

      const templates = await listProtocolTemplates(trainer.accessToken);
      const examples = templates.filter((template) => template.isExample === true);
      expect(examples).toHaveLength(1);
    });

    it('does not mark firstProtocolCreated when the example routine is seeded', async () => {
      const owner = await createTrainer();
      await seedPublicExerciseTemplates(owner.trainerId);

      const trainer = await createTrainer();

      const onboarding = await getOnboarding(trainer.accessToken);
      expect(onboarding.firstProtocolCreatedAt).toBeNull();
      expect(onboarding.firstProtocolCreated).toBe(false);
    });

    it('seeds nothing when no public exercise templates exist', async () => {
      const trainer = await createTrainer();

      expect(await listProtocolTemplates(trainer.accessToken)).toEqual([]);
    });

    it('does not seed a second example when the trainer profile is re-activated', async () => {
      const owner = await createTrainer();
      await seedPublicExerciseTemplates(owner.trainerId);
      const trainer = await createTrainer();

      const reactivate = await app.inject({
        method: 'PATCH',
        url: '/become-trainer',
        headers: auth(trainer.accessToken),
      });
      expect(reactivate.statusCode).toBe(200);

      const templates = await listProtocolTemplates(trainer.accessToken);
      expect(templates.filter((template) => template.isExample === true)).toHaveLength(1);
    });

    it('exposes isExample=false on a protocol template the trainer creates', async () => {
      const trainer = await createTrainer();

      const res = await app.inject({
        method: 'POST',
        url: '/trainer/protocol-templates',
        headers: auth(trainer.accessToken),
        payload: { name: 'Minha rotina' },
      });

      expect(res.statusCode).toBe(201);
      expect(res.json().isExample).toBe(false);
    });

    it('exposes isExample on GET /trainer/protocol-templates/:id for the seeded example', async () => {
      const owner = await createTrainer();
      await seedPublicExerciseTemplates(owner.trainerId);
      const trainer = await createTrainer();
      const [example] = await listProtocolTemplates(trainer.accessToken);

      const res = await app.inject({
        method: 'GET',
        url: `/trainer/protocol-templates/${example.id}`,
        headers: auth(trainer.accessToken),
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().isExample).toBe(true);
    });
  });
});
