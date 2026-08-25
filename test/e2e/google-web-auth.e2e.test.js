import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from 'vitest';
import { prisma } from '../../src/db.js';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';

vi.mock('../../src/services/firebase-id-token-service.js', () => ({
  verifyFirebaseIdToken: vi.fn(),
}));

import { verifyFirebaseIdToken } from '../../src/services/firebase-id-token-service.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

const GOOGLE_SUBJECT = 'google-subject-000001';
const GOOGLE_EMAIL = 'google-user@example.com';

function makeGooglePayload(overrides = {}) {
  return {
    subject: GOOGLE_SUBJECT,
    email: GOOGLE_EMAIL,
    name: 'Google User',
    picture: 'https://lh3.googleusercontent.com/a/mock-avatar',
    emailVerified: true,
    ...overrides,
  };
}

async function seedGoogleUser({ subject = GOOGLE_SUBJECT, email = GOOGLE_EMAIL } = {}) {
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
      provider: 'google',
      providerId: subject,
      accessToken: null,
      refreshToken: null,
      expiresAt: null,
    },
  });

  return user;
}

e2eDescribe('e2e: POST /auth/google/web', () => {
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
    await cleanDatabase();
    vi.clearAllMocks();
  });

  describe('request validation', () => {
    it('should return 400 when idToken is absent from the request body', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/google/web',
        payload: {},
      });

      expect(response.statusCode).toBe(400);
    });

    it('should return 400 conforming to the error contract when idToken is missing', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/google/web',
        payload: {},
      });

      const body = response.json();
      expect(body).toMatchObject({
        error: expect.any(String),
        message: expect.any(String),
      });
    });
  });

  describe('existing Google account', () => {
    it('should return 200 with user, token, and refreshToken when account already linked', async () => {
      await seedGoogleUser();
      verifyFirebaseIdToken.mockResolvedValue(makeGooglePayload());

      const response = await app.inject({
        method: 'POST',
        url: '/auth/google/web',
        payload: { idToken: 'mock-valid-token' },
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
      await seedGoogleUser();
      verifyFirebaseIdToken.mockResolvedValue(makeGooglePayload());

      await app.inject({
        method: 'POST',
        url: '/auth/google/web',
        payload: { idToken: 'mock-valid-token' },
      });

      const userCount = await prisma.user.count();
      expect(userCount).toBe(1);
    });
  });

  describe('first sign-in with email, user does not exist', () => {
    it('should return 200 and create the user + google account on first-time sign-in', async () => {
      verifyFirebaseIdToken.mockResolvedValue(
        makeGooglePayload({ email: `new-${Date.now()}@example.com` }),
      );

      const response = await app.inject({
        method: 'POST',
        url: '/auth/google/web',
        payload: { idToken: 'mock-first-token' },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();

      expect(body).toMatchObject({
        user: { id: expect.any(String) },
        token: { accessToken: expect.any(String) },
        refreshToken: expect.any(String),
      });
    });

    it('should create a google account record linked to the new user', async () => {
      const subject = `google-subject-new-${Date.now()}`;
      verifyFirebaseIdToken.mockResolvedValue(
        makeGooglePayload({ subject, email: `newuser${Date.now()}@example.com` }),
      );

      const response = await app.inject({
        method: 'POST',
        url: '/auth/google/web',
        payload: { idToken: 'mock-first-token' },
      });

      expect(response.statusCode).toBe(200);
      const { user: { id } } = response.json();

      const account = await prisma.account.findFirst({
        where: { userId: id, provider: 'google' },
      });
      expect(account).not.toBeNull();
      expect(account.providerId).toBe(subject);
    });
  });

  describe('first Google sign-in but user already exists by email', () => {
    it('should return 200 (not 201) when a user with that email already exists', async () => {
      const email = `existing-${Date.now()}@example.com`;

      await prisma.user.create({
        data: { email, roles: [], status: 'pending' },
      });

      verifyFirebaseIdToken.mockResolvedValue(makeGooglePayload({ email }));

      const response = await app.inject({
        method: 'POST',
        url: '/auth/google/web',
        payload: { idToken: 'mock-link-token' },
      });

      expect(response.statusCode).toBe(200);
    });

    it('should not create a duplicate user when email already exists', async () => {
      const email = `nodup-${Date.now()}@example.com`;

      await prisma.user.create({
        data: { email, roles: [], status: 'pending' },
      });

      verifyFirebaseIdToken.mockResolvedValue(makeGooglePayload({ email }));

      await app.inject({
        method: 'POST',
        url: '/auth/google/web',
        payload: { idToken: 'mock-link-token' },
      });

      const count = await prisma.user.count({ where: { email } });
      expect(count).toBe(1);
    });
  });

  describe('deleted account', () => {
    async function seedDeletedGoogleUserWithAccessToken(suffix) {
      const subject = `google-subject-deleted-${suffix}-${Date.now()}`;
      const email = `google-deleted-${suffix}-${Date.now()}@example.com`;

      const user = await seedGoogleUser({ subject, email });
      verifyFirebaseIdToken.mockResolvedValue(makeGooglePayload({ subject, email }));

      const firstLoginResponse = await app.inject({
        method: 'POST',
        url: '/auth/google/web',
        payload: { idToken: 'mock-valid-token' },
      });
      expect(firstLoginResponse.statusCode).toBe(200);
      const { token: { accessToken } } = firstLoginResponse.json();

      const deleteResponse = await app.inject({
        method: 'DELETE',
        url: '/me',
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(deleteResponse.statusCode).toBe(204);

      await prisma.account.create({
        data: {
          userId: user.id,
          provider: 'google',
          providerId: subject,
          accessToken: null,
          refreshToken: null,
          expiresAt: null,
        },
      });

      return { subject, email };
    }

    it('should return 403 USER_DELETED when the linked account was deleted', async () => {
      await seedDeletedGoogleUserWithAccessToken('403');

      const response = await app.inject({
        method: 'POST',
        url: '/auth/google/web',
        payload: { idToken: 'mock-valid-token' },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({
        error: 'USER_DELETED',
        messageCode: 'auth.user.deleted',
      });
    });

    it('should translate the message to pt-BR by default', async () => {
      await seedDeletedGoogleUserWithAccessToken('pt-br');

      const response = await app.inject({
        method: 'POST',
        url: '/auth/google/web',
        payload: { idToken: 'mock-valid-token' },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().message).toBe('Esta conta foi excluída.');
    });

    it('should translate the message to en-US when the app-language header requests it', async () => {
      await seedDeletedGoogleUserWithAccessToken('en-us');

      const response = await app.inject({
        method: 'POST',
        url: '/auth/google/web',
        headers: { 'app-language': 'en-US' },
        payload: { idToken: 'mock-valid-token' },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().message).toBe('This account has been deleted.');
    });
  });
});
