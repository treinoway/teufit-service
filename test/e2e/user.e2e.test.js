import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { prisma } from '../../src/db.js';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { AnamnesisQuestionType } from '../../src/constants/anamnesis.js';
import { ChallengeParticipantMode } from '../../src/constants/challenge.js';
import { InviteStatus } from '../../src/constants/trainer-invite.js';
import crypto from 'node:crypto';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

e2eDescribe('e2e: user profile flows', () => {
  let app;

  beforeAll(async () => {
    app = await setupApp();
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  beforeEach(async () => {
    // Clean database between tests to keep them isolated
    await cleanDatabase();
  });

  it('responds on health check /', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ message: "i'm alive" });
  });

  it('can switch activeProfile to trainer via /become-trainer', async () => {
    const email = `e2e+trainer-${Date.now()}@example.com`;
    const password = 'StrongPassw0rd!';

    const signupResponse = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { email, password },
    });

    expect(signupResponse.statusCode).toBe(201);
    const {
      user: { id: userId },
      token: { accessToken },
    } = signupResponse.json();

    // Become trainer
    const becomeTrainerResponse = await app.inject({
      method: 'PATCH',
      url: '/become-trainer',
      headers: {
        authorization: `Bearer ${accessToken}`,
      },
    });

    expect(becomeTrainerResponse.statusCode).toBe(200);
    expect(becomeTrainerResponse.json()).toMatchObject({
      activeProfile: 'trainer',
      token: { accessToken: expect.any(String) },
      refreshToken: expect.any(String),
    });

    // Verify persisted preference in the database
    const prefs = await prisma.userPreferences.findUnique({ where: { userId } });
    expect(prefs).not.toBeNull();
    expect(prefs.activeProfile).toBe('trainer');

    // And verify that the user now has the TRAINER role in addition to existing roles
    const updatedUser = await prisma.user.findUnique({ where: { id: userId } });
    expect(updatedUser.roles).toEqual(expect.arrayContaining(['trainer']));
  });

  describe('user profile update', () => {
    it('successfully updates basic user fields', async () => {
      const email = `profile-update-${Date.now()}@example.com`;
      const password = 'StrongPassw0rd!';

      const signupResponse = await app.inject({
        method: 'POST',
        url: '/auth/signup',
        payload: { email, password },
      });

      expect(signupResponse.statusCode).toBe(201);
      const { token: { accessToken } } = signupResponse.json();

      const updateResponse = await app.inject({
        method: 'PATCH',
        url: '/me/profile',
        headers: {
          authorization: `Bearer ${accessToken}`,
        },
        payload: {
          firstName: 'John',
          lastName: 'Doe',
          gender: 'male',
          birthDate: '1990-05-15',
          address: {
            line1: 'Avenida Paulista, 1000',
            line2: 'Apt 101',
            neighborhood: 'Bela Vista',
            city: 'São Paulo',
            state: 'São Paulo',
            stateCode: 'SP',
            country: 'Brasil',
            countryCode: 'BR',
            postalCode: '01310-100',
          },
          socials: {
            instagram: '@johndoe',
            whatsapp: '+5511999999999',
          },
        },
      });

      expect(updateResponse.statusCode).toBe(200);
      const body = updateResponse.json();

      expect(body).toMatchObject({
        firstName: 'John',
        lastName: 'Doe',
      });
      expect(body.gender).toBe('male');
      expect(body.genderLabel).toBe('Masculino');
      expect(body).toHaveProperty('birthDate');
    });

    it('successfully updates address', async () => {
      const email = `profile-address-${Date.now()}@example.com`;
      const password = 'StrongPassw0rd!';

      const signupResponse = await app.inject({
        method: 'POST',
        url: '/auth/signup',
        payload: { email, password },
      });

      const { token: { accessToken } } = signupResponse.json();

      const updateResponse = await app.inject({
        method: 'PATCH',
        url: '/me/profile',
        headers: {
          authorization: `Bearer ${accessToken}`,
        },
        payload: {
          address: {
            line1: 'Avenida Paulista, 1000',
            line2: 'Apt 101',
            neighborhood: 'Bela Vista',
            city: 'São Paulo',
            state: 'São Paulo',
            stateCode: 'SP',
            country: 'Brasil',
            countryCode: 'BR',
            postalCode: '01310-100',
          },
        },
      });

      expect(updateResponse.statusCode).toBe(200);
      const body = updateResponse.json();

      expect(body).toHaveProperty('address');
      expect(body.address).toMatchObject({
        line1: 'Avenida Paulista, 1000',
        line2: 'Apt 101',
        neighborhood: 'Bela Vista',
        city: 'São Paulo',
        state: 'São Paulo',
        stateCode: 'SP',
        country: 'Brasil',
        countryCode: 'BR',
        postalCode: '01310-100',
      });
    });

    it('successfully updates socials', async () => {
      const email = `profile-socials-${Date.now()}@example.com`;
      const password = 'StrongPassw0rd!';

      const signupResponse = await app.inject({
        method: 'POST',
        url: '/auth/signup',
        payload: { email, password },
      });

      const { token: { accessToken } } = signupResponse.json();

      const updateResponse = await app.inject({
        method: 'PATCH',
        url: '/me/profile',
        headers: {
          authorization: `Bearer ${accessToken}`,
        },
        payload: {
          socials: {
            instagram: '@johndoe',
            whatsapp: '+5511999999999',
            linkedin: 'https://linkedin.com/in/johndoe',
            facebook: 'https://facebook.com/johndoe',
          },
        },
      });

      expect(updateResponse.statusCode).toBe(200);
      const body = updateResponse.json();

      expect(body).toHaveProperty('socials');
      expect(body.socials).toMatchObject({
        instagram: '@johndoe',
        whatsapp: '+5511999999999',
        linkedin: 'https://linkedin.com/in/johndoe',
        facebook: 'https://facebook.com/johndoe',
      });
    });

    it('rejects update without authentication', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: '/me/profile',
        payload: {
          firstName: 'John',
        },
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({
        error: 'Authentication required',
      });
    });

    it('rejects empty update payload', async () => {
      const email = `profile-empty-${Date.now()}@example.com`;
      const password = 'StrongPassw0rd!';

      const signupResponse = await app.inject({
        method: 'POST',
        url: '/auth/signup',
        payload: { email, password },
      });

      const { token: { accessToken } } = signupResponse.json();

      const updateResponse = await app.inject({
        method: 'PATCH',
        url: '/me/profile',
        headers: {
          authorization: `Bearer ${accessToken}`,
        },
        payload: {},
      });

      expect(updateResponse.statusCode).toBe(400);
      expect(updateResponse.json()).toMatchObject({
        error: 'At least one field must be provided',
      });
    });

    it('rejects invalid gender value', async () => {
      const email = `profile-invalid-gender-${Date.now()}@example.com`;
      const password = 'StrongPassw0rd!';

      const signupResponse = await app.inject({
        method: 'POST',
        url: '/auth/signup',
        payload: { email, password },
      });

      const { token: { accessToken } } = signupResponse.json();

      const updateResponse = await app.inject({
        method: 'PATCH',
        url: '/me/profile',
        headers: {
          authorization: `Bearer ${accessToken}`,
        },
        payload: {
          gender: 'invalid_gender',
        },
      });

      expect(updateResponse.statusCode).toBe(400);
    });

    it('rejects invalid birthDate format', async () => {
      const email = `profile-invalid-date-${Date.now()}@example.com`;
      const password = 'StrongPassw0rd!';

      const signupResponse = await app.inject({
        method: 'POST',
        url: '/auth/signup',
        payload: { email, password },
      });

      const { token: { accessToken } } = signupResponse.json();

      const updateResponse = await app.inject({
        method: 'PATCH',
        url: '/me/profile',
        headers: {
          authorization: `Bearer ${accessToken}`,
        },
        payload: {
          birthDate: '15-05-1990', // Wrong format
        },
      });

      expect(updateResponse.statusCode).toBe(400);
    });
  });

  describe('GET /me with lazy loading (?include parameter)', () => {
    let accessToken;
    let userId;

    beforeEach(async () => {
      // Create a user with complete profile data
      const email = `e2e+lazyload-${Date.now()}@example.com`;
      const password = 'StrongPassw0rd!';

      const signupResponse = await app.inject({
        method: 'POST',
        url: '/auth/signup',
        payload: { email, password },
      });

      expect(signupResponse.statusCode).toBe(201);
      const signupBody = signupResponse.json();
      accessToken = signupBody.token.accessToken;
      userId = signupBody.user.id;

      // Update profile with address, socials, and preferences
      await app.inject({
        method: 'PATCH',
        url: '/me/profile',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: {
          firstName: 'John',
          lastName: 'Doe',
          address: {
            line1: '123 Main St',
            city: 'São Paulo',
            state: 'São Paulo',
            stateCode: 'SP',
            country: 'Brasil',
            countryCode: 'BR',
            postalCode: '01310-100',
          },
          socials: {
            instagram: '@johndoe',
            whatsapp: '+5511999999999',
          },
          preferences: {
            rawPreferences: { theme: 'dark', language: 'en' },
          },
        },
      });
    });

    it('returns minimal payload without query parameter', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/me',
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();

      // Should have base fields
      expect(body).toHaveProperty('id', userId);
      expect(body).toHaveProperty('email');
      expect(body).toHaveProperty('roles');
      expect(body).toHaveProperty('firstName', 'John');

      // Should NOT have relations
      expect(body).not.toHaveProperty('address');
      expect(body).not.toHaveProperty('socials');
      expect(body).not.toHaveProperty('preferences');
    });

    it('returns minimal payload with empty ?include parameter', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/me?include=',
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();

      expect(body).toHaveProperty('id');
      expect(body).not.toHaveProperty('address');
      expect(body).not.toHaveProperty('socials');
      expect(body).not.toHaveProperty('preferences');
    });

    it('returns only address when ?include=address', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/me?include=address',
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();

      expect(body).toHaveProperty('address');
      expect(body.address).toMatchObject({
        line1: '123 Main St',
        city: 'São Paulo',
        postalCode: '01310-100',
      });
      expect(body).not.toHaveProperty('socials');
      expect(body).not.toHaveProperty('preferences');
    });

    it('returns only socials when ?include=socials', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/me?include=socials',
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();

      expect(body).toHaveProperty('socials');
      expect(body.socials).toMatchObject({
        instagram: '@johndoe',
        whatsapp: '+5511999999999',
      });
      expect(body).not.toHaveProperty('address');
      expect(body).not.toHaveProperty('preferences');
    });

    it('returns only preferences when ?include=preferences', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/me?include=preferences',
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();

      expect(body).toHaveProperty('preferences');
      expect(body.preferences).toMatchObject({
        rawPreferences: { theme: 'dark', language: 'en' },
      });
      expect(body).not.toHaveProperty('address');
      expect(body).not.toHaveProperty('socials');
    });

    it('returns multiple relations when ?include=address,socials', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/me?include=address,socials',
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();

      expect(body).toHaveProperty('address');
      expect(body).toHaveProperty('socials');
      expect(body.address.city).toBe('São Paulo');
      expect(body.socials.instagram).toBe('@johndoe');
      expect(body).not.toHaveProperty('preferences');
    });

    it('returns all relations when ?include=address,socials,preferences', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/me?include=address,socials,preferences',
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();

      expect(body).toHaveProperty('address');
      expect(body).toHaveProperty('socials');
      expect(body).toHaveProperty('preferences');
      expect(body.address).toBeDefined();
      expect(body.socials).toBeDefined();
      expect(body.preferences).toBeDefined();
    });

    it('returns 400 for invalid relation', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/me?include=accounts',
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(response.statusCode).toBe(400);
      const body = response.json();

      expect(body).toMatchObject({
        error: 'INVALID_RELATIONS',
        allowedRelations: expect.arrayContaining(['address', 'socials', 'preferences']),
      });
      expect(typeof body.message).toBe('string');
    });

    it('returns 400 for mixed valid and invalid relations', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/me?include=address,accounts,refreshTokens',
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(response.statusCode).toBe(400);
      const body = response.json();

      expect(body.error).toBe('INVALID_RELATIONS');
      expect(typeof body.message).toBe('string');
    });

    it('handles whitespace in query parameter', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/me?include= address , socials ',
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();

      expect(body).toHaveProperty('address');
      expect(body).toHaveProperty('socials');
    });

    it('requires authentication', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/me?include=address',
      });

      expect(response.statusCode).toBe(401);
    });
  });

  describe('hasActiveTrainer flag in GET /me and PATCH /me/profile', () => {
    async function createAndAuthUser(suffix) {
      const email = `e2e+has-trainer-${suffix}-${Date.now()}@example.com`;
      const password = 'StrongPassw0rd!';

      const signupRes = await app.inject({
        method: 'POST',
        url: '/auth/signup',
        payload: { email, password },
      });
      expect(signupRes.statusCode).toBe(201);
      const { user: { id: userId }, token: { accessToken } } = signupRes.json();
      return { userId, accessToken, email };
    }

    async function createTrainerAndLinkStudent(studentEmail) {
      // Create a trainer account
      const { accessToken: trainerRawToken } = await createAndAuthUser('trainer');

      const becomeRes = await app.inject({
        method: 'PATCH',
        url: '/become-trainer',
        headers: { authorization: `Bearer ${trainerRawToken}` },
      });
      expect(becomeRes.statusCode).toBe(200);
      const { token: { accessToken: trainerToken } } = becomeRes.json();

      // Link the student to the trainer
      const linkRes = await app.inject({
        method: 'POST',
        url: '/trainer/students',
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: { email: studentEmail },
      });
      expect(linkRes.statusCode).toBe(201);
    }

    it('GET /me returns hasActiveTrainer: false when the user has no trainer link', async () => {
      const { accessToken } = await createAndAuthUser('no-link');

      const response = await app.inject({
        method: 'GET',
        url: '/me',
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toHaveProperty('hasActiveTrainer', false);
    });

    it('GET /me returns hasActiveTrainer: true when the user is linked to a trainer', async () => {
      const { accessToken, email: studentEmail } = await createAndAuthUser('with-link');
      await createTrainerAndLinkStudent(studentEmail);

      const response = await app.inject({
        method: 'GET',
        url: '/me',
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toHaveProperty('hasActiveTrainer', true);
    });

    it('PATCH /me/profile returns hasActiveTrainer: false when the user has no trainer link', async () => {
      const { accessToken } = await createAndAuthUser('patch-no-link');

      const response = await app.inject({
        method: 'PATCH',
        url: '/me/profile',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { firstName: 'Alice' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toHaveProperty('hasActiveTrainer', false);
    });

    it('PATCH /me/profile returns hasActiveTrainer: true when the user is linked to a trainer', async () => {
      const { accessToken, email: studentEmail } = await createAndAuthUser('patch-with-link');
      await createTrainerAndLinkStudent(studentEmail);

      const response = await app.inject({
        method: 'PATCH',
        url: '/me/profile',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { firstName: 'Alice' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toHaveProperty('hasActiveTrainer', true);
    });
  });

  describe('platformPlan in GET /me', () => {
    async function createAndAuthStudent(suffix) {
      const email = `e2e+platform-student-${suffix}-${Date.now()}@example.com`;
      const signupRes = await app.inject({
        method: 'POST',
        url: '/auth/signup',
        payload: { email, password: 'StrongPassw0rd!' },
      });
      expect(signupRes.statusCode).toBe(201);
      const { token: { accessToken } } = signupRes.json();
      return { accessToken, email };
    }

    async function createAndAuthTrainer(suffix) {
      const email = `e2e+platform-trainer-${suffix}-${Date.now()}@example.com`;
      const signupRes = await app.inject({
        method: 'POST',
        url: '/auth/signup',
        payload: { email, password: 'StrongPassw0rd!' },
      });
      expect(signupRes.statusCode).toBe(201);

      const { token: { accessToken: rawToken } } = signupRes.json();

      const becomeRes = await app.inject({
        method: 'PATCH',
        url: '/become-trainer',
        headers: { authorization: `Bearer ${rawToken}` },
      });
      expect(becomeRes.statusCode).toBe(200);

      const { token: { accessToken } } = becomeRes.json();
      return { accessToken, email };
    }

    it('GET /me returns platformPlan for trainer users on FREE tier', async () => {
      const { accessToken } = await createAndAuthTrainer('free-plan');

      const response = await app.inject({
        method: 'GET',
        url: '/me',
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();

      expect(body).toHaveProperty('platformPlan');
      expect(body.platformPlan.tier).toBe('FREE');
      expect(body.platformPlan.status).toBe('ACTIVE');
      expect(body.platformPlan.cancelAtPeriodEnd).toBe(false);
      expect(body.platformPlan.limits).toMatchObject({
        studentCap: 3,
        aiActionsPerStudent: 0,
        aiActionsTrainerCap: 0,
        branding: false,
        championships: false,
      });
      expect(body.platformPlan.usage).toMatchObject({
        students: { active: expect.any(Number), blocked: expect.any(Number), cap: 3 },
        aiActions: { total: 0, byStudent: [] },
      });
    });

    it('GET /me does NOT include platformPlan for student-only users', async () => {
      const { accessToken } = await createAndAuthStudent('no-plan');

      const response = await app.inject({
        method: 'GET',
        url: '/me',
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();

      expect(body).not.toHaveProperty('platformPlan');
    });

    it('GET /me platformPlan shape has all required fields', async () => {
      const { accessToken } = await createAndAuthTrainer('shape-check');

      const response = await app.inject({
        method: 'GET',
        url: '/me',
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(response.statusCode).toBe(200);
      const { platformPlan } = response.json();

      expect(platformPlan).toMatchObject({
        tier: expect.any(String),
        status: expect.any(String),
        cancelAtPeriodEnd: expect.any(Boolean),
        limits: {
          branding: expect.any(Boolean),
          championships: expect.any(Boolean),
        },
        usage: {
          students: {
            active: expect.any(Number),
            blocked: expect.any(Number),
          },
          aiActions: {
            total: expect.any(Number),
            byStudent: expect.any(Array),
          },
        },
      });
    });
  });

  describe('DELETE /me (account self-deletion)', () => {
    async function signup(suffix) {
      const email = `e2e+delete-${suffix}-${Date.now()}@example.com`;
      const password = 'StrongPassw0rd!';

      const signupResponse = await app.inject({
        method: 'POST',
        url: '/auth/signup',
        payload: { email, password },
      });

      expect(signupResponse.statusCode).toBe(201);
      const body = signupResponse.json();
      return {
        email,
        password,
        userId: body.user.id,
        accessToken: body.token.accessToken,
      };
    }

    async function createTrainerWithToken(suffix) {
      const { userId, accessToken: rawToken, email } = await signup(`trainer-${suffix}`);

      const becomeTrainerResponse = await app.inject({
        method: 'PATCH',
        url: '/become-trainer',
        headers: { authorization: `Bearer ${rawToken}` },
      });
      expect(becomeTrainerResponse.statusCode).toBe(200);
      const { token: { accessToken } } = becomeTrainerResponse.json();

      return { userId, accessToken, email };
    }

    async function createNutritionistWithToken(suffix) {
      const { userId, accessToken: rawToken, email } = await signup(`nutritionist-${suffix}`);

      const becomeNutritionistResponse = await app.inject({
        method: 'PATCH',
        url: '/become-nutritionist',
        headers: { authorization: `Bearer ${rawToken}` },
      });
      expect(becomeNutritionistResponse.statusCode).toBe(200);
      const { token: { accessToken } } = becomeNutritionistResponse.json();

      return { userId, accessToken, email };
    }

    async function linkTrainerStudent(trainerToken, studentEmail) {
      const response = await app.inject({
        method: 'POST',
        url: '/trainer/students',
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: { email: studentEmail },
      });
      expect([201, 409]).toContain(response.statusCode);
    }

    async function createProtocolAndTraining(trainerToken, studentId) {
      const meResponse = await app.inject({
        method: 'GET',
        url: '/me',
        headers: { authorization: `Bearer ${trainerToken}` },
      });
      expect(meResponse.statusCode).toBe(200);
      const trainerUserId = meResponse.json().id;
      const trainer = await prisma.trainer.findUnique({
        where: { userId: trainerUserId },
        select: { id: true },
      });
      await prisma.trainerStudent.upsert({
        where: { trainerId_studentId: { trainerId: trainer.id, studentId } },
        create: { trainerId: trainer.id, studentId, activeOnPlan: true },
        update: { activeOnPlan: true },
      });

      const protocolResponse = await app.inject({
        method: 'POST',
        url: '/trainer/protocols',
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: {
          assigneeId: studentId,
          name: 'Deletion Test Protocol',
          startDate: '2026-01-01',
        },
      });
      expect(protocolResponse.statusCode).toBe(201);
      const { id: protocolId } = protocolResponse.json();

      const trainingResponse = await app.inject({
        method: 'POST',
        url: `/trainer/protocols/${protocolId}/trainings`,
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: {
          name: 'Deletion Test Training',
          category: 'strength',
        },
      });
      expect(trainingResponse.statusCode).toBe(201);
      const { id: trainingId } = trainingResponse.json();

      return { trainerId: trainer.id, protocolId, trainingId };
    }

    async function startWorkoutSession(studentToken, trainingId) {
      const response = await app.inject({
        method: 'POST',
        url: `/my/trainings/${trainingId}/workout-sessions`,
        headers: { authorization: `Bearer ${studentToken}` },
        payload: {},
      });
      expect(response.statusCode).toBe(201);
      return response.json().id;
    }

    async function createAnamnesisWithQuestion(trainerToken) {
      const response = await app.inject({
        method: 'POST',
        url: '/trainer/anamneses',
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: {
          title: 'Deletion Test Anamnesis',
          sections: [
            {
              title: 'Section A',
              questions: [
                { text: 'Do you smoke?', type: AnamnesisQuestionType.DICHOTOMOUS, required: true },
              ],
            },
          ],
        },
      });
      expect(response.statusCode).toBe(201);
      const body = response.json();
      return { anamnesisId: body.id, questionId: body.sections[0].questions[0].id };
    }

    async function assignAnamnesisToStudent(trainerToken, studentId, anamnesisId) {
      const response = await app.inject({
        method: 'POST',
        url: `/trainer/students/${studentId}/anamneses`,
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: { anamnesisId },
      });
      expect(response.statusCode).toBe(201);
    }

    async function submitAnamnesisResponse(studentToken, anamnesisId, questionId) {
      const response = await app.inject({
        method: 'POST',
        url: `/my/anamneses/${anamnesisId}/response`,
        headers: { authorization: `Bearer ${studentToken}` },
        payload: { answers: [{ questionId, value: 'yes' }] },
      });
      expect(response.statusCode).toBe(200);
    }

    async function createActiveChallengeWithParticipant(trainerId, studentId) {
      const today = new Date();
      const startDate = new Date(
        Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()),
      );
      const endDate = new Date(
        Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, today.getUTCDate()),
      );

      const challenge = await prisma.challenge.create({
        data: {
          trainerId,
          name: 'Deletion Test Challenge',
          startDate,
          endDate,
          participantMode: ChallengeParticipantMode.EXPLICIT,
          ptsWorkoutCompleted: 10,
          ptsStreak7Days: 50,
          ptsDailyCheckin: 2,
          dailyPointsCap: null,
        },
      });

      await prisma.challengeParticipant.create({
        data: { challengeId: challenge.id, studentId },
      });

      return challenge;
    }

    async function seedPointTransaction(studentId, trainerId, challengeId, points = 10) {
      await prisma.pointTransaction.create({
        data: {
          studentId,
          trainerId,
          challengeId,
          action: 'workout_completed',
          points,
          referenceId: null,
        },
      });
      await prisma.pointBalance.upsert({
        where: { studentId_trainerId: { studentId, trainerId } },
        create: { studentId, trainerId, totalPoints: points },
        update: { totalPoints: { increment: points } },
      });
    }

    async function createAiConversation(userId) {
      return prisma.aiConversation.create({
        data: { userId, title: 'Deletion test conversation' },
      });
    }

    async function linkNutritionistPatient(nutritionistToken, patientEmail) {
      const response = await app.inject({
        method: 'POST',
        url: '/nutritionist/patients',
        headers: { authorization: `Bearer ${nutritionistToken}` },
        payload: { email: patientEmail },
      });
      expect(response.statusCode).toBe(201);
    }

    async function setMetabolicProfile(nutritionistToken, patientId) {
      const response = await app.inject({
        method: 'PUT',
        url: `/nutritionist/patients/${patientId}/metabolic-profile`,
        headers: { authorization: `Bearer ${nutritionistToken}` },
        payload: { weightKg: 70, heightCm: 170 },
      });
      expect(response.statusCode).toBe(200);
    }

    it('rejects unauthenticated requests', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: '/me',
      });

      expect(response.statusCode).toBe(401);
    });

    it('deletes and anonymizes the account, and frees the email for a future signup', async () => {
      const { email, userId, accessToken } = await signup('happy-path');

      const deleteResponse = await app.inject({
        method: 'DELETE',
        url: '/me',
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(deleteResponse.statusCode).toBe(204);
      expect(deleteResponse.body).toBe('');

      const deletedUser = await prisma.user.findUnique({ where: { id: userId } });
      expect(deletedUser).not.toBeNull();
      expect(deletedUser.deletedAt).not.toBeNull();
      expect(deletedUser.email).toBeNull();
      expect(deletedUser.username).toBeNull();
      expect(deletedUser.passwordHash).toBeNull();
      expect(deletedUser.firstName).toBeNull();
      expect(deletedUser.lastName).toBeNull();
      expect(deletedUser.gender).toBeNull();
      expect(deletedUser.birthDate).toBeNull();
      expect(deletedUser.avatarUrl).toBeNull();

      const resignupResponse = await app.inject({
        method: 'POST',
        url: '/auth/signup',
        payload: { email, password: 'AnotherStrongPassw0rd!' },
      });

      expect(resignupResponse.statusCode).toBe(201);
      const resignupBody = resignupResponse.json();
      expect(resignupBody.user.id).not.toBe(userId);

      const resignupUser = await prisma.user.findUnique({ where: { id: resignupBody.user.id } });
      expect(resignupUser.email).toBe(email);
    });

    it('rejects a second deletion with the same still-valid access token as already-deleted', async () => {
      const { accessToken } = await signup('stale-token');

      const firstDelete = await app.inject({
        method: 'DELETE',
        url: '/me',
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(firstDelete.statusCode).toBe(204);

      const secondDelete = await app.inject({
        method: 'DELETE',
        url: '/me',
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(secondDelete.statusCode).toBe(403);
      expect(secondDelete.json()).toMatchObject({
        error: 'USER_DELETED',
        messageCode: 'auth.user.deleted',
      });
    });

    it('cascades deletion across the full data graph (workout session, anamnesis, gamification, AI conversation, profile extras)', async () => {
      const { userId: trainerUserId, accessToken: trainerToken } = await createTrainerWithToken('full-cascade');
      const { email, userId, accessToken } = await signup('full-cascade');

      await linkTrainerStudent(trainerToken, email);
      const { trainerId, trainingId } = await createProtocolAndTraining(trainerToken, userId);
      const sessionId = await startWorkoutSession(accessToken, trainingId);

      const { anamnesisId, questionId } = await createAnamnesisWithQuestion(trainerToken);
      await assignAnamnesisToStudent(trainerToken, userId, anamnesisId);
      await submitAnamnesisResponse(accessToken, anamnesisId, questionId);

      const challenge = await createActiveChallengeWithParticipant(trainerId, userId);
      await seedPointTransaction(userId, trainerId, challenge.id);

      const conversation = await createAiConversation(userId);

      await app.inject({
        method: 'PATCH',
        url: '/me/profile',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: {
          address: {
            line1: 'Avenida Paulista, 1000',
            city: 'São Paulo',
            state: 'São Paulo',
            stateCode: 'SP',
            country: 'Brasil',
            countryCode: 'BR',
            postalCode: '01310-100',
          },
          socials: {
            instagram: '@johndoe',
          },
          preferences: {
            rawPreferences: { theme: 'dark' },
          },
        },
      });

      expect(await prisma.workoutSession.findUnique({ where: { id: sessionId } })).not.toBeNull();
      expect(await prisma.anamnesisResponse.findFirst({ where: { studentId: userId } })).not.toBeNull();
      expect(await prisma.studentAnamnesis.findFirst({ where: { studentId: userId } })).not.toBeNull();
      expect(await prisma.pointTransaction.findFirst({ where: { studentId: userId } })).not.toBeNull();
      expect(await prisma.pointBalance.findFirst({ where: { studentId: userId } })).not.toBeNull();
      expect(await prisma.challengeParticipant.findFirst({ where: { studentId: userId } })).not.toBeNull();
      expect(await prisma.trainerStudent.findFirst({ where: { studentId: userId } })).not.toBeNull();
      expect(await prisma.aiConversation.findUnique({ where: { id: conversation.id } })).not.toBeNull();
      expect(await prisma.address.findFirst({ where: { userId } })).not.toBeNull();
      expect(await prisma.socialNetwork.findFirst({ where: { userId } })).not.toBeNull();
      expect(await prisma.userPreferences.findFirst({ where: { userId } })).not.toBeNull();
      expect(await prisma.account.findMany({ where: { userId } })).not.toHaveLength(0);

      const deleteResponse = await app.inject({
        method: 'DELETE',
        url: '/me',
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(deleteResponse.statusCode).toBe(204);

      expect(await prisma.workoutSession.findUnique({ where: { id: sessionId } })).toBeNull();
      expect(await prisma.anamnesisResponse.findFirst({ where: { studentId: userId } })).toBeNull();
      expect(await prisma.studentAnamnesis.findFirst({ where: { studentId: userId } })).toBeNull();
      expect(await prisma.pointTransaction.findFirst({ where: { studentId: userId } })).toBeNull();
      expect(await prisma.pointBalance.findFirst({ where: { studentId: userId } })).toBeNull();
      expect(await prisma.challengeParticipant.findFirst({ where: { studentId: userId } })).toBeNull();
      expect(await prisma.trainerStudent.findFirst({ where: { studentId: userId } })).toBeNull();
      expect(await prisma.aiConversation.findUnique({ where: { id: conversation.id } })).toBeNull();
      expect(await prisma.address.findFirst({ where: { userId } })).toBeNull();
      expect(await prisma.socialNetwork.findFirst({ where: { userId } })).toBeNull();
      expect(await prisma.userPreferences.findFirst({ where: { userId } })).toBeNull();
      expect(await prisma.account.findMany({ where: { userId } })).toEqual([]);

      const survivingTrainer = await prisma.user.findUnique({ where: { id: trainerUserId } });
      expect(survivingTrainer.deletedAt).toBeNull();
      expect(await prisma.challenge.findUnique({ where: { id: challenge.id } })).not.toBeNull();
    });

    it('does not affect a second student sharing the same trainer, challenge shape, and protocol', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken('isolation');
      const { email: emailA, userId: userIdA, accessToken: tokenA } = await signup('isolation-a');
      const { email: emailB, userId: userIdB, accessToken: tokenB } = await signup('isolation-b');

      await linkTrainerStudent(trainerToken, emailA);
      await linkTrainerStudent(trainerToken, emailB);

      const { trainerId, trainingId: trainingIdA } = await createProtocolAndTraining(trainerToken, userIdA);
      const { trainingId: trainingIdB } = await createProtocolAndTraining(trainerToken, userIdB);

      const sessionIdA = await startWorkoutSession(tokenA, trainingIdA);
      const sessionIdB = await startWorkoutSession(tokenB, trainingIdB);

      const challengeA = await createActiveChallengeWithParticipant(trainerId, userIdA);
      await seedPointTransaction(userIdA, trainerId, challengeA.id);

      const challengeB = await createActiveChallengeWithParticipant(trainerId, userIdB);
      await seedPointTransaction(userIdB, trainerId, challengeB.id);

      const deleteResponse = await app.inject({
        method: 'DELETE',
        url: '/me',
        headers: { authorization: `Bearer ${tokenA}` },
      });
      expect(deleteResponse.statusCode).toBe(204);

      expect(await prisma.workoutSession.findUnique({ where: { id: sessionIdA } })).toBeNull();
      expect(await prisma.pointTransaction.findFirst({ where: { studentId: userIdA } })).toBeNull();
      expect(await prisma.trainerStudent.findFirst({ where: { studentId: userIdA } })).toBeNull();

      expect(await prisma.workoutSession.findUnique({ where: { id: sessionIdB } })).not.toBeNull();
      expect(await prisma.pointTransaction.findFirst({ where: { studentId: userIdB } })).not.toBeNull();
      expect(await prisma.pointBalance.findFirst({ where: { studentId: userIdB } })).not.toBeNull();
      expect(await prisma.trainerStudent.findFirst({ where: { studentId: userIdB } })).not.toBeNull();

      const userB = await prisma.user.findUnique({ where: { id: userIdB } });
      expect(userB.deletedAt).toBeNull();
      expect(userB.email).toBe(emailB);
    });

    it('deletes nutritionistPatient and patientMetabolicProfile rows on account deletion', async () => {
      const { accessToken: nutritionistToken } = await createNutritionistWithToken('nutri-cascade');
      const { userId, email, accessToken } = await signup('nutri-cascade');

      await linkNutritionistPatient(nutritionistToken, email);
      await setMetabolicProfile(nutritionistToken, userId);

      expect(await prisma.nutritionistPatient.findFirst({ where: { patientId: userId } })).not.toBeNull();
      expect(await prisma.patientMetabolicProfile.findFirst({ where: { patientId: userId } })).not.toBeNull();

      const deleteResponse = await app.inject({
        method: 'DELETE',
        url: '/me',
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(deleteResponse.statusCode).toBe(204);

      expect(await prisma.nutritionistPatient.findFirst({ where: { patientId: userId } })).toBeNull();
      expect(await prisma.patientMetabolicProfile.findFirst({ where: { patientId: userId } })).toBeNull();
    });

    it('returns 409 and leaves the account untouched when the account has an active Trainer profile', async () => {
      const { email, userId, accessToken } = await signup('trainer-guard');

      const becomeTrainerResponse = await app.inject({
        method: 'PATCH',
        url: '/become-trainer',
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(becomeTrainerResponse.statusCode).toBe(200);
      const { token: { accessToken: trainerToken } } = becomeTrainerResponse.json();

      const deleteResponse = await app.inject({
        method: 'DELETE',
        url: '/me',
        headers: { authorization: `Bearer ${trainerToken}` },
      });

      expect(deleteResponse.statusCode).toBe(409);
      expect(deleteResponse.json()).toMatchObject({
        error: 'PROFESSIONAL_ACCOUNT_DELETION_UNSUPPORTED',
        messageCode: 'account.deletion.professionalUnsupported',
      });

      const untouchedUser = await prisma.user.findUnique({ where: { id: userId } });
      expect(untouchedUser.deletedAt).toBeNull();
      expect(untouchedUser.email).toBe(email);
    });

    it('returns 409 and leaves the account untouched when the account has an active Nutritionist profile', async () => {
      const { email, userId, accessToken } = await signup('nutritionist-guard');

      const becomeNutritionistResponse = await app.inject({
        method: 'PATCH',
        url: '/become-nutritionist',
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(becomeNutritionistResponse.statusCode).toBe(200);
      const { token: { accessToken: nutritionistToken } } = becomeNutritionistResponse.json();

      const deleteResponse = await app.inject({
        method: 'DELETE',
        url: '/me',
        headers: { authorization: `Bearer ${nutritionistToken}` },
      });

      expect(deleteResponse.statusCode).toBe(409);
      expect(deleteResponse.json()).toMatchObject({
        error: 'PROFESSIONAL_ACCOUNT_DELETION_UNSUPPORTED',
        messageCode: 'account.deletion.professionalUnsupported',
      });

      const untouchedUser = await prisma.user.findUnique({ where: { id: userId } });
      expect(untouchedUser.deletedAt).toBeNull();
      expect(untouchedUser.email).toBe(email);
    });

    it('deletes a matching TrainerInvite row (redeemer userId + bound email) on account deletion', async () => {
      const { email, userId, accessToken } = await signup('invite-cleanup');
      const { userId: inviteSenderId } = await signup('invite-sender');

      const invite = await prisma.trainerInvite.create({
        data: {
          email,
          codeHash: crypto.randomBytes(16).toString('hex'),
          status: InviteStatus.ACCEPTED,
          invitedByUserId: inviteSenderId,
          userId,
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
          acceptedAt: new Date(),
        },
      });

      expect(await prisma.trainerInvite.findUnique({ where: { id: invite.id } })).not.toBeNull();

      const deleteResponse = await app.inject({
        method: 'DELETE',
        url: '/me',
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(deleteResponse.statusCode).toBe(204);

      const survivingInvite = await prisma.trainerInvite.findFirst({
        where: {
          OR: [{ userId }, { email: { equals: email, mode: 'insensitive' } }],
        },
      });
      expect(survivingInvite).toBeNull();
    });

    it('scrubs studentId/userMessage/responseText on an AiInteractionLog row but keeps the row and its metrics', async () => {
      const { userId: trainerUserId } = await createTrainerWithToken('ai-log-scrub');
      const { userId, accessToken } = await signup('ai-log-scrub');

      const trainer = await prisma.trainer.findUnique({
        where: { userId: trainerUserId },
        select: { id: true },
      });

      const seededLog = await prisma.aiInteractionLog.create({
        data: {
          trainerId: trainer.id,
          studentId: userId,
          action: 'some_action',
          userMessage: 'Some message that could contain PII about the student',
          toolsUsed: [{ name: 'some_tool', argsSummary: 'x=1' }],
          responseText: 'Some AI response about the student',
          model: 'test-model',
          inputTokens: 10,
          outputTokens: 20,
          latencyMs: 150,
          status: 'success',
        },
      });

      const deleteResponse = await app.inject({
        method: 'DELETE',
        url: '/me',
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(deleteResponse.statusCode).toBe(204);

      const scrubbedLog = await prisma.aiInteractionLog.findUnique({ where: { id: seededLog.id } });
      expect(scrubbedLog).not.toBeNull();
      expect(scrubbedLog.studentId).toBeNull();
      expect(scrubbedLog.userMessage).toBeNull();
      expect(scrubbedLog.responseText).toBeNull();

      expect(scrubbedLog.trainerId).toBe(trainer.id);
      expect(scrubbedLog.action).toBe('some_action');
      expect(scrubbedLog.toolsUsed).toEqual([{ name: 'some_tool', argsSummary: 'x=1' }]);
      expect(scrubbedLog.model).toBe('test-model');
      expect(scrubbedLog.inputTokens).toBe(10);
      expect(scrubbedLog.outputTokens).toBe(20);
      expect(scrubbedLog.latencyMs).toBe(150);
      expect(scrubbedLog.status).toBe('success');
    });
  });
});
