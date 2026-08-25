import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from 'vitest';
import { prisma } from '../../src/db.js';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';

vi.mock('../../src/services/google-id-token-service.js', () => ({
  verifyGoogleIdToken: vi.fn(),
}));

import { verifyGoogleIdToken } from '../../src/services/google-id-token-service.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

function makeGooglePayload(overrides = {}) {
  return {
    subject: 'google-mobile-subject-000001',
    email: 'google-mobile-user@example.com',
    name: 'Google Mobile User',
    picture: 'https://lh3.googleusercontent.com/a/mock-avatar',
    emailVerified: true,
    ...overrides,
  };
}

async function seedGoogleUser({ subject, email }) {
  const user = await prisma.user.create({
    data: { email: email.toLowerCase(), roles: [], status: 'pending' },
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

e2eDescribe('e2e: POST /auth/google/mobile', () => {
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

  it('should return 400 when idToken is absent from the request body', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/google/mobile',
      payload: {},
    });

    expect(response.statusCode).toBe(400);
  });

  describe('deleted account (USER_DELETED)', () => {
    async function seedDeletedGoogleMobileUserWithAccessToken(suffix) {
      const subject = `google-mobile-subject-deleted-${suffix}-${Date.now()}`;
      const email = `google-mobile-deleted-${suffix}-${Date.now()}@example.com`;

      const user = await seedGoogleUser({ subject, email });
      verifyGoogleIdToken.mockResolvedValue(makeGooglePayload({ subject, email }));

      const firstLoginResponse = await app.inject({
        method: 'POST',
        url: '/auth/google/mobile',
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

    it('returns the full 4-field error contract (error, messageCode, message, details) with 403 USER_DELETED', async () => {
      await seedDeletedGoogleMobileUserWithAccessToken('403');

      const response = await app.inject({
        method: 'POST',
        url: '/auth/google/mobile',
        payload: { idToken: 'mock-valid-token' },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({
        error: 'USER_DELETED',
        messageCode: 'auth.user.deleted',
        message: expect.any(String),
        details: {},
      });
    });

    it('translates the message to pt-BR by default', async () => {
      await seedDeletedGoogleMobileUserWithAccessToken('pt-br');

      const response = await app.inject({
        method: 'POST',
        url: '/auth/google/mobile',
        payload: { idToken: 'mock-valid-token' },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().message).toBe('Esta conta foi excluída.');
    });

    it('translates the message to en-US when the app-language header requests it', async () => {
      await seedDeletedGoogleMobileUserWithAccessToken('en-us');

      const response = await app.inject({
        method: 'POST',
        url: '/auth/google/mobile',
        headers: { 'app-language': 'en-US' },
        payload: { idToken: 'mock-valid-token' },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().message).toBe('This account has been deleted.');
    });
  });
});
