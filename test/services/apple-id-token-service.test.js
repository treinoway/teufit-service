import { createHash } from 'node:crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Must mock jose before importing the service, because the service calls
// createRemoteJWKSet() at module evaluation time.
vi.mock('jose', () => {
  return {
    createRemoteJWKSet: vi.fn(() => 'mock-jwks'),
    jwtVerify: vi.fn(),
  };
});

import { jwtVerify } from 'jose';
import { verifyAppleIdToken } from '../../src/services/apple-id-token-service.js';

const APPLE_ISSUER = 'https://appleid.apple.com';
const APPLE_AUDIENCE = 'com.treinoway.app';

/** Build a minimal valid Apple JWT payload. */
function makePayload(overrides = {}) {
  return {
    sub: 'apple-uid-001',
    iss: APPLE_ISSUER,
    aud: APPLE_AUDIENCE,
    email: 'user@example.com',
    email_verified: true,
    is_private_email: false,
    ...overrides,
  };
}

describe('verifyAppleIdToken', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Input validation
  // -------------------------------------------------------------------------

  describe('input validation', () => {
    it('should throw APPLE_IDENTITY_TOKEN_REQUIRED when identityToken is null', async () => {
      await expect(
        verifyAppleIdToken({ identityToken: null, audience: APPLE_AUDIENCE }),
      ).rejects.toMatchObject({ code: 'APPLE_IDENTITY_TOKEN_REQUIRED', statusCode: 400 });
    });

    it('should throw APPLE_IDENTITY_TOKEN_REQUIRED when identityToken is undefined', async () => {
      await expect(
        verifyAppleIdToken({ identityToken: undefined, audience: APPLE_AUDIENCE }),
      ).rejects.toMatchObject({ code: 'APPLE_IDENTITY_TOKEN_REQUIRED', statusCode: 400 });
    });

    it('should throw APPLE_IDENTITY_TOKEN_REQUIRED when identityToken is empty string', async () => {
      await expect(
        verifyAppleIdToken({ identityToken: '', audience: APPLE_AUDIENCE }),
      ).rejects.toMatchObject({ code: 'APPLE_IDENTITY_TOKEN_REQUIRED', statusCode: 400 });
    });

    it('should throw APPLE_IDENTITY_TOKEN_REQUIRED when identityToken is a number', async () => {
      await expect(
        verifyAppleIdToken({ identityToken: 12345, audience: APPLE_AUDIENCE }),
      ).rejects.toMatchObject({ code: 'APPLE_IDENTITY_TOKEN_REQUIRED', statusCode: 400 });
    });

    it('should throw APPLE_AUDIENCE_REQUIRED when audience is undefined', async () => {
      await expect(
        verifyAppleIdToken({ identityToken: 'valid-token', audience: undefined }),
      ).rejects.toMatchObject({ code: 'APPLE_AUDIENCE_REQUIRED', statusCode: 500 });
    });

    it('should throw APPLE_AUDIENCE_REQUIRED when audience is empty string', async () => {
      await expect(
        verifyAppleIdToken({ identityToken: 'valid-token', audience: '' }),
      ).rejects.toMatchObject({ code: 'APPLE_AUDIENCE_REQUIRED', statusCode: 500 });
    });

    it('should throw APPLE_AUDIENCE_REQUIRED when audience is a comma-separated string of blanks', async () => {
      await expect(
        verifyAppleIdToken({ identityToken: 'valid-token', audience: ' , , ' }),
      ).rejects.toMatchObject({ code: 'APPLE_AUDIENCE_REQUIRED', statusCode: 500 });
    });

    it('should pass multiple audiences from comma-separated string to jwtVerify', async () => {
      jwtVerify.mockResolvedValue({ payload: makePayload() });

      await verifyAppleIdToken({
        identityToken: 'valid-token',
        audience: 'com.treinoway.app,com.treinoway.services',
      });

      expect(jwtVerify).toHaveBeenCalledWith(
        'valid-token',
        'mock-jwks',
        expect.objectContaining({
          audience: ['com.treinoway.app', 'com.treinoway.services'],
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Happy path — valid token
  // -------------------------------------------------------------------------

  describe('valid token', () => {
    it('should return mapped subject, email, emailVerified, and isPrivateEmail on success', async () => {
      jwtVerify.mockResolvedValue({
        payload: makePayload({
          sub: 'apple-sub-xyz',
          email: 'test@icloud.com',
          email_verified: true,
          is_private_email: false,
        }),
      });

      const result = await verifyAppleIdToken({
        identityToken: 'valid-token',
        audience: APPLE_AUDIENCE,
      });

      expect(result).toEqual({
        subject: 'apple-sub-xyz',
        email: 'test@icloud.com',
        emailVerified: true,
        isPrivateEmail: false,
      });
    });

    it('should call jwtVerify with identityToken, mock JWKS, issuer, and parsed audience', async () => {
      jwtVerify.mockResolvedValue({ payload: makePayload() });

      await verifyAppleIdToken({
        identityToken: 'my-token',
        audience: APPLE_AUDIENCE,
      });

      expect(jwtVerify).toHaveBeenCalledWith(
        'my-token',
        'mock-jwks',
        {
          issuer: APPLE_ISSUER,
          audience: [APPLE_AUDIENCE],
        },
      );
    });

    it('should return null for email when payload.email is absent', async () => {
      jwtVerify.mockResolvedValue({
        payload: makePayload({ email: undefined }),
      });

      const result = await verifyAppleIdToken({
        identityToken: 'valid-token',
        audience: APPLE_AUDIENCE,
      });

      expect(result.email).toBeNull();
    });

    it('should return null for email when payload.email is not a string', async () => {
      jwtVerify.mockResolvedValue({
        payload: makePayload({ email: 42 }),
      });

      const result = await verifyAppleIdToken({
        identityToken: 'valid-token',
        audience: APPLE_AUDIENCE,
      });

      expect(result.email).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // asBool normalization: email_verified / is_private_email
  // -------------------------------------------------------------------------

  describe('asBool normalization', () => {
    it('should normalize email_verified boolean true to true', async () => {
      jwtVerify.mockResolvedValue({ payload: makePayload({ email_verified: true }) });

      const result = await verifyAppleIdToken({ identityToken: 'tok', audience: APPLE_AUDIENCE });

      expect(result.emailVerified).toBe(true);
    });

    it('should normalize email_verified string "true" to true', async () => {
      jwtVerify.mockResolvedValue({ payload: makePayload({ email_verified: 'true' }) });

      const result = await verifyAppleIdToken({ identityToken: 'tok', audience: APPLE_AUDIENCE });

      expect(result.emailVerified).toBe(true);
    });

    it('should normalize email_verified boolean false to false', async () => {
      jwtVerify.mockResolvedValue({ payload: makePayload({ email_verified: false }) });

      const result = await verifyAppleIdToken({ identityToken: 'tok', audience: APPLE_AUDIENCE });

      expect(result.emailVerified).toBe(false);
    });

    it('should normalize email_verified string "false" to false', async () => {
      jwtVerify.mockResolvedValue({ payload: makePayload({ email_verified: 'false' }) });

      const result = await verifyAppleIdToken({ identityToken: 'tok', audience: APPLE_AUDIENCE });

      expect(result.emailVerified).toBe(false);
    });

    it('should normalize email_verified undefined to false', async () => {
      jwtVerify.mockResolvedValue({ payload: makePayload({ email_verified: undefined }) });

      const result = await verifyAppleIdToken({ identityToken: 'tok', audience: APPLE_AUDIENCE });

      expect(result.emailVerified).toBe(false);
    });

    it('should normalize is_private_email boolean true to true', async () => {
      jwtVerify.mockResolvedValue({ payload: makePayload({ is_private_email: true }) });

      const result = await verifyAppleIdToken({ identityToken: 'tok', audience: APPLE_AUDIENCE });

      expect(result.isPrivateEmail).toBe(true);
    });

    it('should normalize is_private_email string "true" to true', async () => {
      jwtVerify.mockResolvedValue({ payload: makePayload({ is_private_email: 'true' }) });

      const result = await verifyAppleIdToken({ identityToken: 'tok', audience: APPLE_AUDIENCE });

      expect(result.isPrivateEmail).toBe(true);
    });

    it('should normalize is_private_email string "false" to false', async () => {
      jwtVerify.mockResolvedValue({ payload: makePayload({ is_private_email: 'false' }) });

      const result = await verifyAppleIdToken({ identityToken: 'tok', audience: APPLE_AUDIENCE });

      expect(result.isPrivateEmail).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Issuer check
  // -------------------------------------------------------------------------

  describe('issuer validation', () => {
    it('should throw INVALID_APPLE_ISSUER with statusCode 401 when iss does not match', async () => {
      jwtVerify.mockResolvedValue({
        payload: makePayload({ iss: 'https://accounts.google.com' }),
      });

      await expect(
        verifyAppleIdToken({ identityToken: 'valid-token', audience: APPLE_AUDIENCE }),
      ).rejects.toMatchObject({ code: 'INVALID_APPLE_ISSUER', statusCode: 401 });
    });

    it('should throw INVALID_APPLE_ISSUER when iss is an empty string', async () => {
      jwtVerify.mockResolvedValue({
        payload: makePayload({ iss: '' }),
      });

      await expect(
        verifyAppleIdToken({ identityToken: 'valid-token', audience: APPLE_AUDIENCE }),
      ).rejects.toMatchObject({ code: 'INVALID_APPLE_ISSUER', statusCode: 401 });
    });
  });

  describe('subject validation', () => {
    it('should throw APPLE_SUBJECT_MISSING with statusCode 401 when sub is absent', async () => {
      jwtVerify.mockResolvedValue({
        payload: makePayload({ sub: undefined }),
      });

      await expect(
        verifyAppleIdToken({ identityToken: 'valid-token', audience: APPLE_AUDIENCE }),
      ).rejects.toMatchObject({ code: 'APPLE_SUBJECT_MISSING', statusCode: 401 });
    });

    it('should throw APPLE_SUBJECT_MISSING when sub is not a string', async () => {
      jwtVerify.mockResolvedValue({
        payload: makePayload({ sub: 12345 }),
      });

      await expect(
        verifyAppleIdToken({ identityToken: 'valid-token', audience: APPLE_AUDIENCE }),
      ).rejects.toMatchObject({ code: 'APPLE_SUBJECT_MISSING', statusCode: 401 });
    });
  });

  // -------------------------------------------------------------------------
  // Nonce replay-protection
  // -------------------------------------------------------------------------

  describe('nonce validation', () => {
    it('should succeed when provided nonce SHA256 matches payload.nonce', async () => {
      const rawNonce = 'my-raw-nonce-value';
      const expectedHash = createHash('sha256').update(rawNonce).digest('hex');

      jwtVerify.mockResolvedValue({
        payload: makePayload({ nonce: expectedHash }),
      });

      const result = await verifyAppleIdToken({
        identityToken: 'valid-token',
        audience: APPLE_AUDIENCE,
        nonce: rawNonce,
      });

      expect(result.subject).toBe('apple-uid-001');
    });

    it('should throw APPLE_NONCE_MISMATCH with statusCode 401 when nonce hash does not match', async () => {
      const rawNonce = 'correct-nonce';
      const wrongHash = createHash('sha256').update('wrong-nonce').digest('hex');

      jwtVerify.mockResolvedValue({
        payload: makePayload({ nonce: wrongHash }),
      });

      await expect(
        verifyAppleIdToken({
          identityToken: 'valid-token',
          audience: APPLE_AUDIENCE,
          nonce: rawNonce,
        }),
      ).rejects.toMatchObject({ code: 'APPLE_NONCE_MISMATCH', statusCode: 401 });
    });

    it('should skip nonce check when nonce argument is not provided', async () => {
      jwtVerify.mockResolvedValue({
        payload: makePayload({ nonce: 'some-hash-in-token' }),
      });

      // No nonce arg — should resolve without throwing
      await expect(
        verifyAppleIdToken({
          identityToken: 'valid-token',
          audience: APPLE_AUDIENCE,
        }),
      ).resolves.toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // jose error propagation
  // -------------------------------------------------------------------------

  describe('jose error propagation', () => {
    it('should propagate ERR_JWT_EXPIRED from jwtVerify', async () => {
      const err = new Error('JWT expired');
      err.code = 'ERR_JWT_EXPIRED';
      jwtVerify.mockRejectedValue(err);

      await expect(
        verifyAppleIdToken({ identityToken: 'expired-token', audience: APPLE_AUDIENCE }),
      ).rejects.toMatchObject({ code: 'ERR_JWT_EXPIRED' });
    });

    it('should propagate ERR_JWS_INVALID from jwtVerify', async () => {
      const err = new Error('JWS invalid');
      err.code = 'ERR_JWS_INVALID';
      jwtVerify.mockRejectedValue(err);

      await expect(
        verifyAppleIdToken({ identityToken: 'bad-token', audience: APPLE_AUDIENCE }),
      ).rejects.toMatchObject({ code: 'ERR_JWS_INVALID' });
    });

    it('should propagate ERR_JWS_SIGNATURE_VERIFICATION_FAILED from jwtVerify', async () => {
      const err = new Error('Signature verification failed');
      err.code = 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED';
      jwtVerify.mockRejectedValue(err);

      await expect(
        verifyAppleIdToken({ identityToken: 'tampered-token', audience: APPLE_AUDIENCE }),
      ).rejects.toMatchObject({ code: 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED' });
    });

    it('should propagate ERR_JWT_CLAIM_VALIDATION_FAILED from jwtVerify', async () => {
      const err = new Error('Claim validation failed');
      err.code = 'ERR_JWT_CLAIM_VALIDATION_FAILED';
      jwtVerify.mockRejectedValue(err);

      await expect(
        verifyAppleIdToken({ identityToken: 'bad-aud-token', audience: APPLE_AUDIENCE }),
      ).rejects.toMatchObject({ code: 'ERR_JWT_CLAIM_VALIDATION_FAILED' });
    });

    it('should propagate ERR_JWKS_NO_MATCHING_KEY from jwtVerify', async () => {
      const err = new Error('No matching key in JWKS');
      err.code = 'ERR_JWKS_NO_MATCHING_KEY';
      jwtVerify.mockRejectedValue(err);

      await expect(
        verifyAppleIdToken({ identityToken: 'unknown-kid-token', audience: APPLE_AUDIENCE }),
      ).rejects.toMatchObject({ code: 'ERR_JWKS_NO_MATCHING_KEY' });
    });
  });
});
