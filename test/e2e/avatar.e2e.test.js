import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { prisma } from '../../src/db.js';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

e2eDescribe('e2e: avatar upload', () => {
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

  /**
   * Helper to create authenticated user
   */
  async function createAuthenticatedUser() {
    const email = `avatar-test-${Date.now()}@example.com`;
    const password = 'StrongPassw0rd!';

    const signupResponse = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { email, password },
    });

    expect(signupResponse.statusCode).toBe(201);
    const { user, token } = signupResponse.json();

    return {
      userId: user.id,
      accessToken: token.accessToken,
      email,
    };
  }

  /**
   * Helper to create multipart form data payload
   */
  function createMultipartPayload({ filename, mimetype, content }) {
    const parts = [];

    parts.push(`------WebKitFormBoundary7MA4YWxkTrZu0gW`);
    parts.push(`Content-Disposition: form-data; name="file"; filename="${filename}"`);
    parts.push(`Content-Type: ${mimetype}`);
    parts.push('');
    parts.push(content.toString('binary'));
    parts.push(`------WebKitFormBoundary7MA4YWxkTrZu0gW--`);

    return {
      payload: parts.join('\r\n'),
      contentType: `multipart/form-data; boundary=----WebKitFormBoundary7MA4YWxkTrZu0gW`,
    };
  }

  it('successfully uploads avatar image', async () => {
    const { userId, accessToken } = await createAuthenticatedUser();

    const { payload, contentType } = createMultipartPayload({
      filename: 'avatar.jpg',
      mimetype: 'image/jpeg',
      content: Buffer.from('fake-jpeg-data'),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/me/avatar',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': contentType,
      },
      payload,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();

    expect(body).toHaveProperty('avatarUrl');
    expect(body.avatarUrl).toBeTruthy();

    // Verify S3 key stored in database
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { avatarUrl: true },
    });
    expect(user.avatarUrl).toBeTruthy();
  });

  it('successfully uploads PNG avatar', async () => {
    const { accessToken } = await createAuthenticatedUser();

    const { payload, contentType } = createMultipartPayload({
      filename: 'avatar.png',
      mimetype: 'image/png',
      content: Buffer.from('fake-png-data'),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/me/avatar',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': contentType,
      },
      payload,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.avatarUrl).toBeTruthy();
  });

  it('successfully uploads WebP avatar', async () => {
    const { accessToken } = await createAuthenticatedUser();

    const { payload, contentType } = createMultipartPayload({
      filename: 'avatar.webp',
      mimetype: 'image/webp',
      content: Buffer.from('fake-webp-data'),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/me/avatar',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': contentType,
      },
      payload,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.avatarUrl).toBeTruthy();
  });

  it('replaces existing avatar when uploading new one', async () => {
    const { userId, accessToken } = await createAuthenticatedUser();

    // Upload first avatar (JPEG)
    const { payload: payload1, contentType: contentType1 } = createMultipartPayload({
      filename: 'avatar1.jpg',
      mimetype: 'image/jpeg',
      content: Buffer.from('first-avatar'),
    });

    const response1 = await app.inject({
      method: 'POST',
      url: '/me/avatar',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': contentType1,
      },
      payload: payload1,
    });

    expect(response1.statusCode).toBe(200);

    // Upload second avatar with different extension (PNG)
    const { payload: payload2, contentType: contentType2 } = createMultipartPayload({
      filename: 'avatar2.png',
      mimetype: 'image/png',
      content: Buffer.from('second-avatar'),
    });

    const response2 = await app.inject({
      method: 'POST',
      url: '/me/avatar',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': contentType2,
      },
      payload: payload2,
    });

    expect(response2.statusCode).toBe(200);
    expect(response2.json()).toHaveProperty('avatarUrl');

    // Database should have the new S3 key
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { avatarUrl: true },
    });

    // In disabled mode, S3 handler returns the key, not a URL
    // The key follows pattern: avatars/{userId}.{extension}
    expect(user.avatarUrl).toMatch(/^avatars\/.+\.png$/);
  });

  it('rejects upload without authentication', async () => {
    const { payload, contentType } = createMultipartPayload({
      filename: 'avatar.jpg',
      mimetype: 'image/jpeg',
      content: Buffer.from('fake-jpeg-data'),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/me/avatar',
      headers: {
        'content-type': contentType,
      },
      payload,
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      error: 'Authentication required',
    });
  });

  it('rejects upload without file', async () => {
    const { accessToken } = await createAuthenticatedUser();

    const response = await app.inject({
      method: 'POST',
      url: '/me/avatar',
      headers: {
        authorization: `Bearer ${accessToken}`,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: 'FILE_REQUIRED',
    });
  });

  it('rejects unsupported file types', async () => {
    const { accessToken } = await createAuthenticatedUser();

    const { payload, contentType } = createMultipartPayload({
      filename: 'document.pdf',
      mimetype: 'application/pdf',
      content: Buffer.from('fake-pdf-content'),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/me/avatar',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': contentType,
      },
      payload,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: 'INVALID_FILE_TYPE',
    });
  });

  it('rejects GIF files', async () => {
    const { accessToken } = await createAuthenticatedUser();

    const { payload, contentType } = createMultipartPayload({
      filename: 'animated.gif',
      mimetype: 'image/gif',
      content: Buffer.from('fake-gif-content'),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/me/avatar',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': contentType,
      },
      payload,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: 'INVALID_FILE_TYPE',
    });
  });

  it('rejects files larger than 5MB', async () => {
    const { accessToken } = await createAuthenticatedUser();

    // Create a buffer larger than 5MB
    const largeBuffer = Buffer.alloc(6 * 1024 * 1024); // 6MB

    const { payload, contentType } = createMultipartPayload({
      filename: 'large-avatar.jpg',
      mimetype: 'image/jpeg',
      content: largeBuffer,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/me/avatar',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': contentType,
      },
      payload,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: 'FILE_TOO_LARGE',
    });
  });

  it('accepts files at the size limit (5MB)', async () => {
    const { accessToken } = await createAuthenticatedUser();

    // Create a buffer exactly 5MB
    const maxBuffer = Buffer.alloc(5 * 1024 * 1024);

    const { payload, contentType } = createMultipartPayload({
      filename: 'max-size-avatar.jpg',
      mimetype: 'image/jpeg',
      content: maxBuffer,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/me/avatar',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': contentType,
      },
      payload,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.avatarUrl).toBeTruthy();
  });

  it('returns only avatarUrl after avatar upload', async () => {
    const { accessToken } = await createAuthenticatedUser();

    // Upload avatar
    const { payload, contentType } = createMultipartPayload({
      filename: 'avatar.jpg',
      mimetype: 'image/jpeg',
      content: Buffer.from('fake-jpeg-data'),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/me/avatar',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': contentType,
      },
      payload,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();

    // Should return only avatarUrl
    expect(body).toHaveProperty('avatarUrl');
    expect(body.avatarUrl).toBeTruthy();
    expect(Object.keys(body)).toEqual(['avatarUrl']);
  });
});
