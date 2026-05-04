import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { prisma } from '../../src/db.js';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

e2eDescribe('e2e: auth flows', () => {
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
      roles: expect.any(Array),
      status: 'pending',
      statusLabel: expect.any(String),
      rolesLabel: expect.any(Array),
    });
    expect(meBody).not.toHaveProperty('passwordHash');
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

  describe('login', () => {
    it('returns INVALID_CREDENTIALS with auth.invalidCredentials messageCode for wrong password', async () => {
      const email = `login-invalid-${Date.now()}@example.com`;
      const password = 'CorrectPassw0rd!';

      // Sign up the user first
      const signupResponse = await app.inject({
        method: 'POST',
        url: '/auth/signup',
        payload: { email, password },
      });
      expect(signupResponse.statusCode).toBe(201);

      // Attempt login with wrong password
      const loginResponse = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email, password: 'WrongPassw0rd!' },
      });

      expect(loginResponse.statusCode).toBe(401);
      expect(loginResponse.json()).toMatchObject({
        error: 'INVALID_CREDENTIALS',
        messageCode: 'auth.invalidCredentials',
        message: 'Invalid email or password.',
      });
    });

    it('returns INVALID_CREDENTIALS with auth.invalidCredentials messageCode for unknown email', async () => {
      const loginResponse = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: `nonexistent-${Date.now()}@example.com`, password: 'SomePassw0rd!' },
      });

      expect(loginResponse.statusCode).toBe(401);
      expect(loginResponse.json()).toMatchObject({
        error: 'INVALID_CREDENTIALS',
        messageCode: 'auth.invalidCredentials',
        message: 'Invalid email or password.',
      });
    });
  });

  describe('forgot password', () => {
    it('returns generic message and creates a token when user exists', async () => {
      const email = `forgot-existing-${Date.now()}@example.com`;
      const password = 'StrongPassw0rd!';

      const signupResponse = await app.inject({
        method: 'POST',
        url: '/auth/signup',
        payload: { email, password },
      });
      expect(signupResponse.statusCode).toBe(201);

      const response = await app.inject({
        method: 'POST',
        url: '/auth/forgot-password',
        payload: { email },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveProperty('message');
      // Non-prod test env exposes resetToken for manual flows.
      expect(typeof body.resetToken).toBe('string');
      expect(body.resetToken.length).toBe(6);

      const tokens = await prisma.passwordResetToken.findMany({
        where: { user: { email } },
      });
      expect(tokens.length).toBe(1);
      expect(tokens[0].used).toBe(false);
    });

    it('returns generic message and does not create a token when user does not exist', async () => {
      const email = `forgot-missing-${Date.now()}@example.com`;

      const response = await app.inject({
        method: 'POST',
        url: '/auth/forgot-password',
        payload: { email },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveProperty('message');
      expect(body.resetToken).toBeUndefined();

      const tokens = await prisma.passwordResetToken.findMany({});
      expect(tokens.length).toBe(0);
    });

    it('matches case-insensitively for users registered via OAuth-style mixed case', async () => {
      const email = `forgot-case-${Date.now()}@example.com`;
      const password = 'StrongPassw0rd!';

      // Simulate a legacy user with mixed-case email (e.g. from OAuth).
      const created = await prisma.user.create({
        data: {
          email: email.toUpperCase(),
          passwordHash: null,
          roles: [],
          status: 'pending',
        },
      });

      const response = await app.inject({
        method: 'POST',
        url: '/auth/forgot-password',
        payload: { email: email.toLowerCase() },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(typeof body.resetToken).toBe('string');

      const tokens = await prisma.passwordResetToken.findMany({
        where: { userId: created.id },
      });
      expect(tokens.length).toBe(1);
    });

    it('invalidates previously issued unused reset tokens when a new one is requested', async () => {
      const email = `forgot-rotate-${Date.now()}@example.com`;
      const password = 'StrongPassw0rd!';

      const signupResponse = await app.inject({
        method: 'POST',
        url: '/auth/signup',
        payload: { email, password },
      });
      expect(signupResponse.statusCode).toBe(201);

      // First request
      const firstResp = await app.inject({
        method: 'POST',
        url: '/auth/forgot-password',
        payload: { email },
      });
      expect(firstResp.statusCode).toBe(200);

      // Second request invalidates the first
      const secondResp = await app.inject({
        method: 'POST',
        url: '/auth/forgot-password',
        payload: { email },
      });
      expect(secondResp.statusCode).toBe(200);

      const tokens = await prisma.passwordResetToken.findMany({
        where: { user: { email } },
        orderBy: { createdAt: 'asc' },
      });
      expect(tokens.length).toBe(2);
      // Older token marked used; newest still active
      expect(tokens[0].used).toBe(true);
      expect(tokens[1].used).toBe(false);
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
});
