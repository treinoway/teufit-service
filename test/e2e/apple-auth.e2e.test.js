import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from 'vitest';
import { prisma } from '../../src/db.js';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';

// Mock Apple token verification so the E2E tests do not require real JWKS
// network calls or a valid RS256 token.  Vitest hoists vi.mock() calls before
// any imports so this intercepts the service imported by auth-route.js.
vi.mock('../../src/services/apple-id-token-service.js', () => ({
  verifyAppleIdToken: vi.fn(),
}));

import { verifyAppleIdToken } from '../../src/services/apple-id-token-service.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

const APPLE_SUBJECT = 'apple.000001.abcdef1234567890abcdef12345.0000';
const APPLE_EMAIL = 'apple-user@privaterelay.appleid.com';

/** Default payload returned by the mock when the token is valid. */
function makeApplePayload(overrides = {}) {
  return {
    subject: APPLE_SUBJECT,
    email: APPLE_EMAIL,
    emailVerified: true,
    isPrivateEmail: true,
    ...overrides,
  };
}

/** Create a user + linked Apple account in the database directly. */
async function seedAppleUser({ subject = APPLE_SUBJECT, email = APPLE_EMAIL } = {}) {
  const user = await prisma.user.create({
    data: {
      email: email.toLowerCase(),
      roles: [],
      status: 'pending',
    },
  });

  await prisma.account.create({
    data: {
      userId: user.id,
      provider: 'apple',
      providerId: subject,
      accessToken: null,
      refreshToken: null,
      expiresAt: null,
    },
  });

  return user;
}

e2eDescribe('e2e: POST /auth/apple/mobile', () => {
  let app;

  beforeAll(async () => {
    process.env.APPLE_BUNDLE_ID = 'com.treinoway.app';
    app = await setupApp();
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  beforeEach(async () => {
    await cleanDatabase();
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Schema / request validation
  // -------------------------------------------------------------------------

  describe('request validation', () => {
    it('should return 400 when identityToken is absent from the request body', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/apple/mobile',
        payload: {},
      });

      expect(response.statusCode).toBe(400);
    });

    it('should return 400 conforming to the error contract when identityToken is missing', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/apple/mobile',
        payload: {},
      });

      const body = response.json();
      expect(body).toMatchObject({
        error: expect.any(String),
        message: expect.any(String),
      });
    });
  });

  // -------------------------------------------------------------------------
  // Existing Apple account → 200 login
  // -------------------------------------------------------------------------

  describe('existing Apple account', () => {
    it('should return 200 with user, token, and refreshToken when account already linked', async () => {
      await seedAppleUser();
      verifyAppleIdToken.mockResolvedValue(makeApplePayload());

      const response = await app.inject({
        method: 'POST',
        url: '/auth/apple/mobile',
        payload: { identityToken: 'mock-valid-token' },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();

      expect(body).toMatchObject({
        user: { id: expect.any(String) },
        token: { accessToken: expect.any(String) },
        refreshToken: expect.any(String),
      });
    });

    it('should not create a duplicate user on subsequent login with existing account', async () => {
      await seedAppleUser();
      verifyAppleIdToken.mockResolvedValue(makeApplePayload());

      await app.inject({
        method: 'POST',
        url: '/auth/apple/mobile',
        payload: { identityToken: 'mock-valid-token' },
      });

      const userCount = await prisma.user.count();
      expect(userCount).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // No account, email present, user does NOT exist → 201 created
  // -------------------------------------------------------------------------

  describe('first sign-in with email, user does not exist', () => {
    it('should return 201 and create the user + apple account on first-time sign-in', async () => {
      verifyAppleIdToken.mockResolvedValue(makeApplePayload());

      const response = await app.inject({
        method: 'POST',
        url: '/auth/apple/mobile',
        payload: { identityToken: 'mock-first-token' },
      });

      expect(response.statusCode).toBe(201);
      const body = response.json();

      expect(body).toMatchObject({
        user: { id: expect.any(String) },
        token: { accessToken: expect.any(String) },
        refreshToken: expect.any(String),
      });
    });

    it('should persist the new user in the database after first sign-in', async () => {
      verifyAppleIdToken.mockResolvedValue(makeApplePayload({ email: `new-${Date.now()}@privaterelay.appleid.com` }));

      const response = await app.inject({
        method: 'POST',
        url: '/auth/apple/mobile',
        payload: { identityToken: 'mock-first-token' },
      });

      expect(response.statusCode).toBe(201);
      const { user: { id } } = response.json();

      const dbUser = await prisma.user.findUnique({ where: { id } });
      expect(dbUser).not.toBeNull();
    });

    it('should create an apple account record linked to the new user', async () => {
      const subject = `apple.NEW.${Date.now()}`;
      verifyAppleIdToken.mockResolvedValue(makeApplePayload({ subject, email: `newuser${Date.now()}@example.com` }));

      const response = await app.inject({
        method: 'POST',
        url: '/auth/apple/mobile',
        payload: { identityToken: 'mock-first-token' },
      });

      expect(response.statusCode).toBe(201);
      const { user: { id } } = response.json();

      const account = await prisma.account.findFirst({
        where: { userId: id, provider: 'apple' },
      });
      expect(account).not.toBeNull();
      expect(account.providerId).toBe(subject);
    });
  });

  // -------------------------------------------------------------------------
  // No account, email present, user EXISTS (e.g. Google/email user) → 200 link
  // -------------------------------------------------------------------------

  describe('first Apple sign-in but user already exists by email', () => {
    it('should return 200 (not 201) when a user with that email already exists', async () => {
      const email = `existing-${Date.now()}@example.com`;

      // Create a user via email signup first
      await prisma.user.create({
        data: { email, roles: [], status: 'pending' },
      });

      verifyAppleIdToken.mockResolvedValue(makeApplePayload({ email }));

      const response = await app.inject({
        method: 'POST',
        url: '/auth/apple/mobile',
        payload: { identityToken: 'mock-link-token' },
      });

      expect(response.statusCode).toBe(200);
    });

    it('should not create a duplicate user when email already exists', async () => {
      const email = `nodup-${Date.now()}@example.com`;

      await prisma.user.create({
        data: { email, roles: [], status: 'pending' },
      });

      verifyAppleIdToken.mockResolvedValue(makeApplePayload({ email }));

      await app.inject({
        method: 'POST',
        url: '/auth/apple/mobile',
        payload: { identityToken: 'mock-link-token' },
      });

      const count = await prisma.user.count({ where: { email } });
      expect(count).toBe(1);
    });

    it('should create an apple account record linked to the existing user', async () => {
      const email = `link-${Date.now()}@example.com`;
      const subject = `apple.LINK.${Date.now()}`;

      const existingUser = await prisma.user.create({
        data: { email, roles: [], status: 'pending' },
      });

      verifyAppleIdToken.mockResolvedValue(makeApplePayload({ subject, email }));

      await app.inject({
        method: 'POST',
        url: '/auth/apple/mobile',
        payload: { identityToken: 'mock-link-token' },
      });

      const account = await prisma.account.findFirst({
        where: { userId: existingUser.id, provider: 'apple' },
      });
      expect(account).not.toBeNull();
      expect(account.providerId).toBe(subject);
    });
  });

  // -------------------------------------------------------------------------
  // No account + no email → 401 first-login-requires-email
  // -------------------------------------------------------------------------

  describe('first Apple sign-in with no email in token', () => {
    it('should return 401 AUTH_APPLE_FIRST_LOGIN_REQUIRES_EMAIL when account absent and email is null', async () => {
      verifyAppleIdToken.mockResolvedValue(
        makeApplePayload({ subject: 'apple.NO-EMAIL.001', email: null }),
      );

      const response = await app.inject({
        method: 'POST',
        url: '/auth/apple/mobile',
        payload: { identityToken: 'mock-no-email-token' },
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({
        error: 'AUTH_APPLE_FIRST_LOGIN_REQUIRES_EMAIL',
        messageCode: 'auth.apple.firstLoginRequiresEmail',
        message: expect.any(String),
        details: expect.anything(),
      });
    });
  });

  // -------------------------------------------------------------------------
  // Token verification errors → 401 AUTH_APPLE_INVALID_TOKEN
  // -------------------------------------------------------------------------

  describe('invalid token errors from verifyAppleIdToken', () => {
    const invalidTokenCases = [
      { label: 'ERR_JWT_EXPIRED', code: 'ERR_JWT_EXPIRED' },
      { label: 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED', code: 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED' },
      { label: 'ERR_JWT_CLAIM_VALIDATION_FAILED', code: 'ERR_JWT_CLAIM_VALIDATION_FAILED' },
      { label: 'APPLE_NONCE_MISMATCH', code: 'APPLE_NONCE_MISMATCH' },
      { label: 'INVALID_APPLE_ISSUER', code: 'INVALID_APPLE_ISSUER' },
      { label: 'ERR_JWS_INVALID', code: 'ERR_JWS_INVALID' },
      { label: 'ERR_JWKS_NO_MATCHING_KEY', code: 'ERR_JWKS_NO_MATCHING_KEY' },
    ];

    for (const { label, code } of invalidTokenCases) {
      it(`should return 401 AUTH_APPLE_INVALID_TOKEN when verifyAppleIdToken throws ${label}`, async () => {
        const err = new Error(label);
        err.code = code;
        verifyAppleIdToken.mockRejectedValue(err);

        const response = await app.inject({
          method: 'POST',
          url: '/auth/apple/mobile',
          payload: { identityToken: 'bad-token' },
        });

        expect(response.statusCode).toBe(401);
        expect(response.json()).toMatchObject({
          error: 'AUTH_APPLE_INVALID_TOKEN',
          messageCode: 'auth.apple.invalidToken',
          message: expect.any(String),
          details: expect.anything(),
        });
      });
    }
  });

  // -------------------------------------------------------------------------
  // Server misconfiguration (APPLE_AUDIENCE_REQUIRED) → 500 APPLE_AUTH_FAILED
  // -------------------------------------------------------------------------

  describe('server misconfiguration', () => {
    it('should return 500 APPLE_AUTH_FAILED when verifyAppleIdToken throws APPLE_AUDIENCE_REQUIRED', async () => {
      const err = new Error('Missing Apple audience');
      err.code = 'APPLE_AUDIENCE_REQUIRED';
      verifyAppleIdToken.mockRejectedValue(err);

      const response = await app.inject({
        method: 'POST',
        url: '/auth/apple/mobile',
        payload: { identityToken: 'any-token' },
      });

      expect(response.statusCode).toBe(500);
      expect(response.json()).toMatchObject({
        error: 'APPLE_AUTH_FAILED',
        messageCode: 'auth.apple.failed',
        message: expect.any(String),
        details: expect.anything(),
      });
    });

    it('should not leak internal error details in the 500 APPLE_AUTH_FAILED response', async () => {
      const err = new Error('Missing Apple audience (APPLE_BUNDLE_ID not set)');
      err.code = 'APPLE_AUDIENCE_REQUIRED';
      verifyAppleIdToken.mockRejectedValue(err);

      const response = await app.inject({
        method: 'POST',
        url: '/auth/apple/mobile',
        payload: { identityToken: 'any-token' },
      });

      const body = response.json();
      expect(body.message).not.toContain('APPLE_BUNDLE_ID');
      expect(body.message).not.toContain('bundle id');
    });
  });
});
