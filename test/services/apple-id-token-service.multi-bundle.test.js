import { describe, it, expect, vi, beforeAll } from 'vitest';
import { generateKeyPair, SignJWT } from 'jose';

// Holds the local public key so the mocked JWKS needs no network.
const holder = vi.hoisted(() => ({ publicKey: null }));

vi.mock('jose', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createRemoteJWKSet: () => async () => holder.publicKey,
  };
});

import { verifyAppleIdToken } from '../../src/services/apple-id-token-service.js';

const APPLE_ISSUER = 'https://appleid.apple.com';
const STUDENT_BUNDLE_ID = 'br.com.teufit.app';
const COACH_BUNDLE_ID = 'br.com.teufit.coach';
const FOREIGN_BUNDLE_ID = 'com.evil.app';
const APPLE_SUBJECT = 'apple-uid-multi-bundle';
const JWT_ALG = 'RS256';
const JWT_LIFETIME = '5m';
const CONFIGURED_LIST = `${STUDENT_BUNDLE_ID},${COACH_BUNDLE_ID}`;

let privateKey;

// Signs an Apple-shaped identity token for the given audience with the local test key.
async function signToken(audience) {
  return new SignJWT({ email: 'coach@example.com', email_verified: true })
    .setProtectedHeader({ alg: JWT_ALG })
    .setIssuer(APPLE_ISSUER)
    .setAudience(audience)
    .setSubject(APPLE_SUBJECT)
    .setIssuedAt()
    .setExpirationTime(JWT_LIFETIME)
    .sign(privateKey);
}

describe('verifyAppleIdToken with several configured bundle ids', () => {
  beforeAll(async () => {
    const pair = await generateKeyPair(JWT_ALG);
    privateKey = pair.privateKey;
    holder.publicKey = pair.publicKey;
  });

  it('should accept a token whose audience is the first bundle id in the list', async () => {
    const token = await signToken(STUDENT_BUNDLE_ID);

    const result = await verifyAppleIdToken({ identityToken: token, audience: CONFIGURED_LIST });

    expect(result.subject).toBe(APPLE_SUBJECT);
  });

  it('should accept a token whose audience is the second bundle id in the list', async () => {
    const token = await signToken(COACH_BUNDLE_ID);

    const result = await verifyAppleIdToken({ identityToken: token, audience: CONFIGURED_LIST });

    expect(result.subject).toBe(APPLE_SUBJECT);
  });

  it('should accept a list with spaces around the separator', async () => {
    const token = await signToken(COACH_BUNDLE_ID);

    const result = await verifyAppleIdToken({
      identityToken: token,
      audience: ` ${STUDENT_BUNDLE_ID} , ${COACH_BUNDLE_ID} `,
    });

    expect(result.subject).toBe(APPLE_SUBJECT);
  });

  it('should keep accepting a single configured bundle id', async () => {
    const token = await signToken(STUDENT_BUNDLE_ID);

    const result = await verifyAppleIdToken({ identityToken: token, audience: STUDENT_BUNDLE_ID });

    expect(result.subject).toBe(APPLE_SUBJECT);
  });

  it('should reject a token whose audience is not in the list', async () => {
    const token = await signToken(FOREIGN_BUNDLE_ID);

    await expect(
      verifyAppleIdToken({ identityToken: token, audience: CONFIGURED_LIST }),
    ).rejects.toMatchObject({ code: 'ERR_JWT_CLAIM_VALIDATION_FAILED' });
  });

  it('should reject a token whose audience only starts with a listed bundle id', async () => {
    const token = await signToken(`${COACH_BUNDLE_ID}.evil`);

    await expect(
      verifyAppleIdToken({ identityToken: token, audience: CONFIGURED_LIST }),
    ).rejects.toMatchObject({ code: 'ERR_JWT_CLAIM_VALIDATION_FAILED' });
  });

  it('should reject the other app bundle id when only one is configured', async () => {
    const token = await signToken(COACH_BUNDLE_ID);

    await expect(
      verifyAppleIdToken({ identityToken: token, audience: STUDENT_BUNDLE_ID }),
    ).rejects.toMatchObject({ code: 'ERR_JWT_CLAIM_VALIDATION_FAILED' });
  });
});
