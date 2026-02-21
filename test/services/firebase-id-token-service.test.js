import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('jose', () => {
  return {
    createRemoteJWKSet: vi.fn(() => 'mock-jwks'),
    jwtVerify: vi.fn(),
  };
});

import { jwtVerify } from 'jose';
import { verifyFirebaseIdToken } from '../../src/services/firebase-id-token-service.js';

const PROJECT_ID = 'treinoway-hml';

describe('verifyFirebaseIdToken', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should throw ID_TOKEN_REQUIRED when idToken is missing', async () => {
    await expect(
      verifyFirebaseIdToken({ idToken: null, projectId: PROJECT_ID }),
    ).rejects.toMatchObject({ code: 'ID_TOKEN_REQUIRED', statusCode: 400 });
  });

  it('should throw ID_TOKEN_REQUIRED when idToken is empty string', async () => {
    await expect(
      verifyFirebaseIdToken({ idToken: '', projectId: PROJECT_ID }),
    ).rejects.toMatchObject({ code: 'ID_TOKEN_REQUIRED', statusCode: 400 });
  });

  it('should throw FIREBASE_PROJECT_ID_REQUIRED when projectId is missing', async () => {
    await expect(
      verifyFirebaseIdToken({ idToken: 'some-token', projectId: null }),
    ).rejects.toMatchObject({ code: 'FIREBASE_PROJECT_ID_REQUIRED', statusCode: 500 });
  });

  it('should return decoded user data on valid token', async () => {
    jwtVerify.mockResolvedValue({
      payload: {
        sub: 'firebase-uid-123',
        email: 'user@example.com',
        name: 'Test User',
        picture: 'https://example.com/photo.jpg',
        email_verified: true,
        iss: `https://securetoken.google.com/${PROJECT_ID}`,
        aud: PROJECT_ID,
      },
    });

    const result = await verifyFirebaseIdToken({
      idToken: 'valid-firebase-token',
      projectId: PROJECT_ID,
    });

    expect(result).toEqual({
      subject: 'firebase-uid-123',
      email: 'user@example.com',
      name: 'Test User',
      picture: 'https://example.com/photo.jpg',
      emailVerified: true,
    });

    expect(jwtVerify).toHaveBeenCalledWith(
      'valid-firebase-token',
      'mock-jwks',
      {
        audience: PROJECT_ID,
        issuer: `https://securetoken.google.com/${PROJECT_ID}`,
      },
    );
  });

  it('should return null for missing optional fields', async () => {
    jwtVerify.mockResolvedValue({
      payload: {
        sub: 'firebase-uid-456',
        iss: `https://securetoken.google.com/${PROJECT_ID}`,
        aud: PROJECT_ID,
      },
    });

    const result = await verifyFirebaseIdToken({
      idToken: 'valid-token-minimal',
      projectId: PROJECT_ID,
    });

    expect(result).toEqual({
      subject: 'firebase-uid-456',
      email: null,
      name: null,
      picture: null,
      emailVerified: false,
    });
  });

  it('should throw INVALID_FIREBASE_TOKEN when sub is missing', async () => {
    jwtVerify.mockResolvedValue({
      payload: {
        email: 'user@example.com',
        iss: `https://securetoken.google.com/${PROJECT_ID}`,
        aud: PROJECT_ID,
      },
    });

    await expect(
      verifyFirebaseIdToken({ idToken: 'token-no-sub', projectId: PROJECT_ID }),
    ).rejects.toMatchObject({ code: 'INVALID_FIREBASE_TOKEN', statusCode: 401 });
  });

  it('should propagate jose errors (expired, invalid signature)', async () => {
    const joseError = new Error('JWT expired');
    joseError.code = 'ERR_JWT_EXPIRED';
    jwtVerify.mockRejectedValue(joseError);

    await expect(
      verifyFirebaseIdToken({ idToken: 'expired-token', projectId: PROJECT_ID }),
    ).rejects.toMatchObject({ code: 'ERR_JWT_EXPIRED' });
  });
});
