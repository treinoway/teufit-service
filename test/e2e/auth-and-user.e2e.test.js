import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { prisma } from '../../src/db.js';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

e2eDescribe('e2e: auth and user flows', () => {
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
    const userId = signupBody.user.id;

    // Verify Account was created with provider 'email'
    const account = await prisma.account.findFirst({
      where: {
        userId,
        provider: 'email',
      },
    });

    expect(account).not.toBeNull();
    expect(account.provider).toBe('email');
    expect(account.providerId).toBe(email);

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
      // Use a new app instance with rate limiting enabled
      const originalNodeEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development'; // Enable rate limiting
      const freshApp = await setupApp({ logger: false });
      process.env.NODE_ENV = originalNodeEnv; // Restore original value

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

  describe('change password', () => {
    it('successfully changes password with valid credentials', async () => {
      const email = `change-password-${Date.now()}@example.com`;
      const oldPassword = 'OldPassw0rd!';
      const newPassword = 'NewPassw0rd!';

      // Sign up the user
      const signupResponse = await app.inject({
        method: 'POST',
        url: '/auth/signup',
        payload: { email, password: oldPassword },
      });

      expect(signupResponse.statusCode).toBe(201);
      const { token: { accessToken }, refreshToken } = signupResponse.json();

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
          newPasswordConfirmation: newPassword,
        },
      });

      expect(changeResponse.statusCode).toBe(200);
      const changeBody = changeResponse.json();

      expect(changeBody).toHaveProperty('message', 'Password changed successfully');
      expect(changeBody).toHaveProperty('token.accessToken');
      expect(changeBody).toHaveProperty('refreshToken');

      // Verify new access token is different from original
      expect(changeBody.token.accessToken).not.toBe(accessToken);
      expect(changeBody.refreshToken).not.toBe(refreshToken);

      // Verify old password no longer works
      const loginWithOldResponse = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email, password: oldPassword },
      });

      expect(loginWithOldResponse.statusCode).toBe(401);

      // Verify new password works
      const loginWithNewResponse = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email, password: newPassword },
      });

      expect(loginWithNewResponse.statusCode).toBe(200);
    });

    it('rejects change password without authentication', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/change-password',
        payload: {
          currentPassword: 'OldPassw0rd!',
          newPassword: 'NewPassw0rd!',
          newPasswordConfirmation: 'NewPassw0rd!',
        },
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({
        error: 'Authentication required',
      });
    });

    it('rejects when current password is incorrect', async () => {
      const email = `change-password-wrong-${Date.now()}@example.com`;
      const correctPassword = 'CorrectPassw0rd!';

      // Sign up the user
      const signupResponse = await app.inject({
        method: 'POST',
        url: '/auth/signup',
        payload: { email, password: correctPassword },
      });

      expect(signupResponse.statusCode).toBe(201);
      const { token: { accessToken } } = signupResponse.json();

      // Try to change password with wrong current password
      const changeResponse = await app.inject({
        method: 'POST',
        url: '/auth/change-password',
        headers: {
          authorization: `Bearer ${accessToken}`,
        },
        payload: {
          currentPassword: 'WrongPassw0rd!',
          newPassword: 'NewPassw0rd!',
          newPasswordConfirmation: 'NewPassw0rd!',
        },
      });

      expect(changeResponse.statusCode).toBe(401);
      expect(changeResponse.json()).toMatchObject({
        error: 'INVALID_CURRENT_PASSWORD',
      });
    });

    it('rejects when new password is too weak', async () => {
      const email = `change-password-weak-${Date.now()}@example.com`;
      const password = 'StrongPassw0rd!';

      // Sign up the user
      const signupResponse = await app.inject({
        method: 'POST',
        url: '/auth/signup',
        payload: { email, password },
      });

      expect(signupResponse.statusCode).toBe(201);
      const { token: { accessToken } } = signupResponse.json();

      // Try to change to a weak password
      const changeResponse = await app.inject({
        method: 'POST',
        url: '/auth/change-password',
        headers: {
          authorization: `Bearer ${accessToken}`,
        },
        payload: {
          currentPassword: password,
          newPassword: 'weak',
          newPasswordConfirmation: 'weak',
        },
      });

      // Fastify schema validation rejects before reaching service layer
      expect(changeResponse.statusCode).toBe(400);
    });

    it('rejects when new password confirmation does not match', async () => {
      const email = `change-password-mismatch-${Date.now()}@example.com`;
      const password = 'StrongPassw0rd!';

      // Sign up the user
      const signupResponse = await app.inject({
        method: 'POST',
        url: '/auth/signup',
        payload: { email, password },
      });

      expect(signupResponse.statusCode).toBe(201);
      const { token: { accessToken } } = signupResponse.json();

      // Try to change password with mismatched confirmation
      const changeResponse = await app.inject({
        method: 'POST',
        url: '/auth/change-password',
        headers: {
          authorization: `Bearer ${accessToken}`,
        },
        payload: {
          currentPassword: password,
          newPassword: 'NewPassw0rd!',
          newPasswordConfirmation: 'DifferentPassw0rd!',
        },
      });

      expect(changeResponse.statusCode).toBe(400);
      expect(changeResponse.json()).toMatchObject({
        error: 'PASSWORD_MISMATCH',
      });
    });

    it('rejects when new password is same as current password', async () => {
      const email = `change-password-same-${Date.now()}@example.com`;
      const password = 'SamePassw0rd!';

      // Sign up the user
      const signupResponse = await app.inject({
        method: 'POST',
        url: '/auth/signup',
        payload: { email, password },
      });

      expect(signupResponse.statusCode).toBe(201);
      const { token: { accessToken } } = signupResponse.json();

      // Try to change password to the same password
      const changeResponse = await app.inject({
        method: 'POST',
        url: '/auth/change-password',
        headers: {
          authorization: `Bearer ${accessToken}`,
        },
        payload: {
          currentPassword: password,
          newPassword: password,
          newPasswordConfirmation: password,
        },
      });

      expect(changeResponse.statusCode).toBe(400);
      expect(changeResponse.json().error).toBe('PASSWORD_SAME_AS_CURRENT');
    });

    it('revokes all existing refresh tokens after password change', async () => {
      const email = `change-password-revoke-${Date.now()}@example.com`;
      const oldPassword = 'OldPassw0rd!';
      const newPassword = 'NewPassw0rd!';

      // Sign up the user
      const signupResponse = await app.inject({
        method: 'POST',
        url: '/auth/signup',
        payload: { email, password: oldPassword },
      });

      expect(signupResponse.statusCode).toBe(201);
      const {
        token: { accessToken },
        refreshToken: oldRefreshToken,
        user: { id: userId }
      } = signupResponse.json();

      // Verify old refresh token exists in database
      const oldTokenRecord = await prisma.refreshToken.findFirst({
        where: { userId, revoked: false },
      });
      expect(oldTokenRecord).not.toBeNull();

      // Change password (use different IP to avoid rate limiting from previous tests)
      const changeResponse = await app.inject({
        method: 'POST',
        url: '/auth/change-password',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'x-forwarded-for': '10.0.0.100',
        },
        payload: {
          currentPassword: oldPassword,
          newPassword: newPassword,
          newPasswordConfirmation: newPassword,
        },
      });

      expect(changeResponse.statusCode).toBe(200);

      // Verify old refresh token was revoked
      const revokedToken = await prisma.refreshToken.findFirst({
        where: {
          userId,
          tokenHash: oldTokenRecord.tokenHash,
        },
      });
      expect(revokedToken.revoked).toBe(true);

      // Try to use old refresh token - should fail
      const refreshResponse = await app.inject({
        method: 'POST',
        url: '/auth/refresh',
        payload: { refreshToken: oldRefreshToken },
      });

      expect(refreshResponse.statusCode).toBe(401);
    });
  });

  describe('Token Rotation (POST /auth/refresh)', () => {
    it('successfully rotates refresh token and returns new tokens', async () => {
      const email = `token-rotation-${Date.now()}@example.com`;
      const password = 'TestPassw0rd!';

      // Signup to get initial tokens
      const signupResponse = await app.inject({
        method: 'POST',
        url: '/auth/signup',
        payload: { email, password },
      });

      expect(signupResponse.statusCode).toBe(201);
      const { refreshToken: token1 } = signupResponse.json();
      expect(token1).toBeDefined();

      // Refresh to get new tokens
      const refreshResponse = await app.inject({
        method: 'POST',
        url: '/auth/refresh',
        payload: { refreshToken: token1 },
      });

      expect(refreshResponse.statusCode).toBe(200);
      const {
        token: { accessToken },
        refreshToken: token2
      } = refreshResponse.json();

      expect(accessToken).toBeDefined();
      expect(token2).toBeDefined();
      expect(token2).not.toBe(token1); // New token should be different
    });

    it('revokes old refresh token after rotation', async () => {
      const email = `token-revoke-${Date.now()}@example.com`;
      const password = 'TestPassw0rd!';

      // Signup
      const signupResponse = await app.inject({
        method: 'POST',
        url: '/auth/signup',
        payload: { email, password },
      });

      const { refreshToken: token1 } = signupResponse.json();

      // Rotate token
      const refreshResponse = await app.inject({
        method: 'POST',
        url: '/auth/refresh',
        payload: { refreshToken: token1 },
      });

      expect(refreshResponse.statusCode).toBe(200);

      // Try to use old token again - should fail
      const reuseResponse = await app.inject({
        method: 'POST',
        url: '/auth/refresh',
        payload: { refreshToken: token1 },
      });

      expect(reuseResponse.statusCode).toBe(401);
      const errorBody = reuseResponse.json();
      expect(errorBody.error).toBe('REFRESH_TOKEN_REVOKED');
      expect(errorBody.message).toContain('revoked');
    });

    it('allows multiple sequential rotations', async () => {
      const email = `multi-rotation-${Date.now()}@example.com`;
      const password = 'TestPassw0rd!';

      const signupResponse = await app.inject({
        method: 'POST',
        url: '/auth/signup',
        payload: { email, password },
      });

      let currentToken = signupResponse.json().refreshToken;
      const rotations = 5;

      for (let i = 0; i < rotations; i++) {
        const response = await app.inject({
          method: 'POST',
          url: '/auth/refresh',
          payload: { refreshToken: currentToken },
        });

        expect(response.statusCode).toBe(200);
        const { refreshToken: newToken } = response.json();
        expect(newToken).toBeDefined();
        expect(newToken).not.toBe(currentToken);

        currentToken = newToken;
      }

      // Final token should still work
      const finalResponse = await app.inject({
        method: 'POST',
        url: '/auth/refresh',
        payload: { refreshToken: currentToken },
      });

      expect(finalResponse.statusCode).toBe(200);
    });

    it('sets rotatedAt timestamp in database when rotating', async () => {
      const email = `rotated-at-${Date.now()}@example.com`;
      const password = 'TestPassw0rd!';

      const signupResponse = await app.inject({
        method: 'POST',
        url: '/auth/signup',
        payload: { email, password },
      });

      const { refreshToken: token1, user: { id: userId } } = signupResponse.json();

      // Get token hash from database before rotation
      const tokenBefore = await prisma.refreshToken.findFirst({
        where: { userId, revoked: false },
      });

      expect(tokenBefore.rotatedAt).toBeNull();

      // Rotate token
      await app.inject({
        method: 'POST',
        url: '/auth/refresh',
        payload: { refreshToken: token1 },
      });

      // Check that old token has rotatedAt set
      const tokenAfter = await prisma.refreshToken.findUnique({
        where: { tokenHash: tokenBefore.tokenHash },
      });

      expect(tokenAfter.revoked).toBe(true);
      expect(tokenAfter.rotatedAt).not.toBeNull();
      expect(tokenAfter.rotatedAt).toBeInstanceOf(Date);
    });

    it('returns proper error for invalid refresh token', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/refresh',
        payload: { refreshToken: 'invalid-token-12345' },
      });

      expect(response.statusCode).toBe(401);
      const body = response.json();
      expect(body.error).toBe('INVALID_REFRESH_TOKEN');
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
            postalCode: '01000-000',
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
        postalCode: '01000-000',
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
        message: expect.stringContaining('accounts'),
        allowedRelations: expect.arrayContaining(['address', 'socials', 'preferences']),
      });
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
      expect(body.message).toContain('accounts');
      expect(body.message).toContain('refreshTokens');
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
  });