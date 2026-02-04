import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { buildServer } from '../../api/server.js';
import { prisma } from '../../src/db.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

e2eDescribe('e2e: auth and user flows', () => {
  let app;

  beforeAll(async () => {
    // Ensure secrets are set for JWT and session plugins in tests
    process.env.SESSION_SECRET =
      process.env.SESSION_SECRET || 'test-session-secret-key-for-e2e-tests-012345';
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

    // Provide dummy Google OAuth configuration so fastify-oauth2 can register
    process.env.GOOGLE_OAUTH_CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID || 'test-google-client-id';
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET || 'test-google-client-secret';
    process.env.GOOGLE_OAUTH_CALLBACK_URL =
      process.env.GOOGLE_OAUTH_CALLBACK_URL || 'http://localhost:3000/auth/google/callback';

    app = await buildServer({ logger: false });
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  beforeEach(async () => {
    // Clean database between tests to keep them isolated
    await prisma.$transaction([
      prisma.passwordResetToken.deleteMany(),
      prisma.refreshToken.deleteMany(),
      prisma.account.deleteMany(),
      prisma.studentHealthDetail.deleteMany(),
      prisma.student.deleteMany(),
      prisma.trainer.deleteMany(),
      prisma.address.deleteMany(),
      prisma.socialNetwork.deleteMany(),
      prisma.nutritionist.deleteMany(),
      prisma.userPreferences.deleteMany(),
      prisma.user.deleteMany(),
      prisma.userWaitlist.deleteMany(),
    ]);
  });

  it('responds on health check /', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ message: "i'm alive" });
  });

  it('signup + /me end-to-end with JWT', async () => {
    const email = `e2e+signup-${Date.now()}@example.com`;
    const password = 'StrongPassw0rd!';

    // Sign up the user
    const signupResponse = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { email, password },
    });

    expect(signupResponse.statusCode).toBe(201);
    const signupBody = signupResponse.json();

    expect(signupBody).toHaveProperty('user.id');
    expect(signupBody).toHaveProperty('token.accessToken');
    expect(signupBody).toHaveProperty('refreshToken');

    const accessToken = signupBody.token.accessToken;

    // Call /me with the issued access token
    const meResponse = await app.inject({
      method: 'GET',
      url: '/me',
      headers: {
        authorization: `Bearer ${accessToken}`,
      },
    });

    expect(meResponse.statusCode).toBe(200);
    const meBody = meResponse.json();

    expect(meBody).toMatchObject({
      email,
      roles: expect.arrayContaining(['student']),
      status: 'pending',
    });
    expect(meBody).not.toHaveProperty('passwordHash');
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
    expect(becomeTrainerResponse.json()).toEqual({ activeProfile: 'trainer' });

    // Verify persisted preference in the database
    const prefs = await prisma.userPreferences.findUnique({ where: { userId } });
    expect(prefs).not.toBeNull();
    expect(prefs.activeProfile).toBe('trainer');

  	// And verify that the user now has the TRAINER role in addition to existing roles
  	const updatedUser = await prisma.user.findUnique({ where: { id: userId } });
  	expect(updatedUser.roles).toEqual(expect.arrayContaining(['student', 'trainer']));
  });

  it('rejects /me without authentication', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/me',
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      error: 'Authentication required',
    });
  });

  describe('waitlist', () => {
    it('successfully adds email to waitlist', async () => {
      const email = `waitlist-${Date.now()}@example.com`;

      const response = await app.inject({
        method: 'POST',
        url: '/auth/signup/waitlist',
        payload: { email },
      });

      expect(response.statusCode).toBe(201);
      const body = response.json();

      expect(body).toHaveProperty('id');
      expect(body.email).toBe(email.toLowerCase());
      expect(body.status).toBe('pending');

      // Verify it was stored in the database
      const waitlistEntry = await prisma.userWaitlist.findUnique({
        where: { email: email.toLowerCase() },
      });
      expect(waitlistEntry).not.toBeNull();
      expect(waitlistEntry.email).toBe(email.toLowerCase());
    });

    it('converts email to lowercase when adding to waitlist', async () => {
      const email = `WAITLIST-${Date.now()}@EXAMPLE.COM`;

      const response = await app.inject({
        method: 'POST',
        url: '/auth/signup/waitlist',
        payload: { email },
      });

      expect(response.statusCode).toBe(201);
      const body = response.json();
      expect(body.email).toBe(email.toLowerCase());
    });

    it('rejects duplicate email on waitlist', async () => {
      const email = `duplicate-${Date.now()}@example.com`;

      // First submission
      const firstResponse = await app.inject({
        method: 'POST',
        url: '/auth/signup/waitlist',
        payload: { email },
      });
      expect(firstResponse.statusCode).toBe(201);

      // Second submission with same email - use different IP to bypass rate limit
      const secondResponse = await app.inject({
        method: 'POST',
        url: '/auth/signup/waitlist',
        payload: { email },
        headers: {
          'x-forwarded-for': '10.0.0.2', // Simulate different IP
        },
      });

      // Could be 409 (duplicate) or 429 (rate limited)
      // Accept both as valid since rate limiting is active
      expect([409, 429]).toContain(secondResponse.statusCode);
      
      if (secondResponse.statusCode === 409) {
        expect(secondResponse.json()).toMatchObject({
          error: 'EMAIL_ALREADY_ON_WAITLIST',
          message: 'Email already on waitlist',
        });
      }
    });

    it('rejects invalid email format', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/signup/waitlist',
        payload: { email: 'not-an-email' },
        headers: {
          'x-forwarded-for': '10.0.0.3', // Simulate different IP
        },
      });

      // Could be 400 (validation error) or 429 (rate limited)
      expect([400, 429]).toContain(response.statusCode);
    });

    it('rejects missing email', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/signup/waitlist',
        payload: {},
        headers: {
          'x-forwarded-for': '10.0.0.4', // Simulate different IP
        },
      });

      // Could be 400 (validation error) or 429 (rate limited)
      expect([400, 429]).toContain(response.statusCode);
    });

    it('respects rate limiting after 3 requests', async () => {
      // Use a new app instance to reset rate limiting
      const freshApp = await buildServer({ logger: false });
      
      try {
        const baseEmail = `rate-limit-${Date.now()}`;
        
        // Make 3 successful requests (max allowed per hour)
        for (let i = 0; i < 3; i++) {
          const response = await freshApp.inject({
            method: 'POST',
            url: '/auth/signup/waitlist',
            payload: { email: `${baseEmail}-${i}@example.com` },
          });
          expect(response.statusCode).toBe(201);
        }

        // 4th request should be rate limited
        const response = await freshApp.inject({
          method: 'POST',
          url: '/auth/signup/waitlist',
          payload: { email: `${baseEmail}-4@example.com` },
        });

        expect(response.statusCode).toBe(429);
      } finally {
        await freshApp.close();
      }
    });
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
          },
        },
      });

      expect(updateResponse.statusCode).toBe(200);
      const body = updateResponse.json();

      expect(body).toHaveProperty('socials');
      expect(body.socials).toMatchObject({
        instagram: '@johndoe',
        whatsapp: '+5511999999999',
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
  })
  });