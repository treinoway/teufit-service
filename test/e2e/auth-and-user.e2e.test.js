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
    process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret';
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

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
});
