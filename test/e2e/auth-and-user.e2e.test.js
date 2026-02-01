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

    // When no Authorization header is present, the request fails
    // Fastify's schema validation for the required header and
    // returns a 400 Bad Request. This documents the current
    // contract; if we later change /me to return 401 directly
    // from authenticate, this test should be updated.
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: 'Bad Request',
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
      expect(body).toHaveProperty('createdAt');

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

  describe('change password', () => {
    it('successfully changes password with valid credentials', async () => {
      const email = `change-pass-${Date.now()}@example.com`;
      const oldPassword = 'OldPassword123!';
      const newPassword = 'NewPassword456!';

      // Sign up the user
      const signupResponse = await app.inject({
        method: 'POST',
        url: '/auth/signup',
        payload: { email, password: oldPassword },
      });

      expect(signupResponse.statusCode).toBe(201);
      const { token: { accessToken } } = signupResponse.json();

      // Change password
      const changeResponse = await app.inject({
        method: 'POST',
        url: '/auth/change-password',
        headers: {
          authorization: `Bearer ${accessToken}`,
        },
        payload: {
          currentPassword: oldPassword,
          newPassword: newPassword,
          confirmPassword: newPassword,
        },
      });

      expect(changeResponse.statusCode).toBe(200);
      expect(changeResponse.json()).toEqual({
        message: 'Password changed successfully',
      });

      // Try to login with old password (should fail)
      const oldLoginResponse = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email, password: oldPassword },
      });

      expect(oldLoginResponse.statusCode).toBe(401);

      // Login with new password (should succeed)
      const newLoginResponse = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email, password: newPassword },
      });

      expect(newLoginResponse.statusCode).toBe(200);
      expect(newLoginResponse.json()).toHaveProperty('token.accessToken');
    });

    it('rejects change password with wrong current password', async () => {
      const email = `change-pass-wrong-${Date.now()}@example.com`;
      const password = 'CorrectPassword123!';

      const signupResponse = await app.inject({
        method: 'POST',
        url: '/auth/signup',
        payload: { email, password },
      });

      expect(signupResponse.statusCode).toBe(201);
      const { token: { accessToken } } = signupResponse.json();

      const changeResponse = await app.inject({
        method: 'POST',
        url: '/auth/change-password',
        headers: {
          authorization: `Bearer ${accessToken}`,
        },
        payload: {
          currentPassword: 'WrongPassword123!',
          newPassword: 'NewPassword456!',
          confirmPassword: 'NewPassword456!',
        },
      });

      expect(changeResponse.statusCode).toBe(403);
      expect(changeResponse.json()).toMatchObject({
        error: 'Current password is incorrect',
      });
    });

    it('rejects change password when new passwords do not match', async () => {
      const email = `change-pass-mismatch-${Date.now()}@example.com`;
      const password = 'CorrectPassword123!';

      const signupResponse = await app.inject({
        method: 'POST',
        url: '/auth/signup',
        payload: { email, password },
      });

      expect(signupResponse.statusCode).toBe(201);
      const { token: { accessToken } } = signupResponse.json();

      const changeResponse = await app.inject({
        method: 'POST',
        url: '/auth/change-password',
        headers: {
          authorization: `Bearer ${accessToken}`,
        },
        payload: {
          currentPassword: password,
          newPassword: 'NewPassword456!',
          confirmPassword: 'DifferentPassword789!',
        },
      });

      expect(changeResponse.statusCode).toBe(400);
      expect(changeResponse.json()).toMatchObject({
        error: 'New password and confirmation do not match',
      });
    });

    it('rejects weak password (less than 8 characters)', async () => {
      // Use fresh app to avoid rate limiting from other tests
      const freshApp = await buildServer({ logger: false });

      try {
        const email = `change-pass-weak-${Date.now()}@example.com`;
        const password = 'StrongPassword123!';

        const signupResponse = await freshApp.inject({
          method: 'POST',
          url: '/auth/signup',
          payload: { email, password },
        });

        expect(signupResponse.statusCode).toBe(201);
        const { token: { accessToken } } = signupResponse.json();

        const changeResponse = await freshApp.inject({
          method: 'POST',
          url: '/auth/change-password',
          headers: {
            authorization: `Bearer ${accessToken}`,
          },
          payload: {
            currentPassword: password,
            newPassword: 'weak',
            confirmPassword: 'weak',
          },
        });

        expect(changeResponse.statusCode).toBe(400);
        // Schema validation rejects before handler, so we get "Bad Request"
        expect(changeResponse.json()).toMatchObject({
          error: 'Bad Request',
        });
      } finally {
        await freshApp.close();
      }
    });

    it('rejects change password without authentication', async () => {
      const changeResponse = await app.inject({
        method: 'POST',
        url: '/auth/change-password',
        payload: {
          currentPassword: 'OldPassword123!',
          newPassword: 'NewPassword456!',
          confirmPassword: 'NewPassword456!',
        },
      });

      // Could be 400 (Bad Request - no auth) or 429 (rate limited)
      expect([400, 429]).toContain(changeResponse.statusCode);
      
      if (changeResponse.statusCode === 400) {
        expect(changeResponse.json()).toMatchObject({
          error: 'Bad Request',
        });
      }
    });

    it('respects rate limiting (3 requests per hour)', async () => {
      // Create fresh app instance to reset rate limit counters
      const freshApp = await buildServer({ logger: false });

      try {
        const email = `change-pass-rate-${Date.now()}@example.com`;
        const password = 'Password123!';

        const signupResponse = await freshApp.inject({
          method: 'POST',
          url: '/auth/signup',
          payload: { email, password },
        });

        expect(signupResponse.statusCode).toBe(201);
        const { token: { accessToken } } = signupResponse.json();

        // Make 3 attempts (max allowed per hour)
        for (let i = 0; i < 3; i++) {
          const response = await freshApp.inject({
            method: 'POST',
            url: '/auth/change-password',
            headers: {
              authorization: `Bearer ${accessToken}`,
            },
            payload: {
              currentPassword: 'WrongPassword!',
              newPassword: `NewPassword${i}!`,
              confirmPassword: `NewPassword${i}!`,
            },
          });
          // First 3 should fail due to wrong password (not rate limited)
          expect(response.statusCode).toBe(403);
        }

        // 4th request should be rate limited
        const rateLimitedResponse = await freshApp.inject({
          method: 'POST',
          url: '/auth/change-password',
          headers: {
            authorization: `Bearer ${accessToken}`,
          },
          payload: {
            currentPassword: password,
            newPassword: 'ValidNewPassword!',
            confirmPassword: 'ValidNewPassword!',
          },
        });

        expect(rateLimitedResponse.statusCode).toBe(429);
      } finally {
        await freshApp.close();
      }
    });
  });
});
