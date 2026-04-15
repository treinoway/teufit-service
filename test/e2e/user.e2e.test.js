import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { prisma } from '../../src/db.js';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';

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
});
