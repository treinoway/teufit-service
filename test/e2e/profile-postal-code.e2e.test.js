import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { signupVerified } from '../helpers/signup-user.js';

const PASSWORD = 'StrongPassw0rd!';
const KNOWN_POSTAL_CODE = '01310-100';
const UNKNOWN_POSTAL_CODE = '11111-111';
const NOT_FOUND_CODE = 'POSTAL_CODE_NOT_FOUND';
const API_ERROR_CODE = 'POSTAL_CODE_API_ERROR';
const LEGACY_MESSAGE_CODE_PREFIX = 'legacy.';
const HTTP_NOT_FOUND = 404;
const HTTP_BAD_GATEWAY = 502;

describe('e2e: PATCH /me/profile postal code lookup failures', () => {
  let app;
  let accessToken;

  const patchProfile = (postalCode) =>
    app.inject({
      method: 'PATCH',
      url: '/me/profile',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { address: { line1: 'Rua Teste, 10', city: 'Sao Paulo', postalCode } },
    });

  const expectErrorContract = (body, { error }) => {
    expect(body).toMatchObject({
      error,
      messageCode: `${LEGACY_MESSAGE_CODE_PREFIX}${error}`,
      message: expect.any(String),
    });
  };

  beforeAll(async () => {
    app = await setupApp();
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    await cleanDatabase();
    vi.stubEnv('DISABLE_POSTAL_CODE_VALIDATION', 'false');
    const res = await signupVerified(app, {
      payload: { email: `postal-${Date.now()}@example.com`, password: PASSWORD },
    });
    accessToken = res.json().token.accessToken;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('should answer 404 postalCodeNotFound in the standard error shape when the CEP does not exist', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ erro: true }) })));

    const res = await patchProfile(UNKNOWN_POSTAL_CODE);

    expect(res.statusCode).toBe(HTTP_NOT_FOUND);
    expectErrorContract(res.json(), { error: NOT_FOUND_CODE });
  });

  it('should answer 502 in the standard error shape when the postal code API responds with a failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));

    const res = await patchProfile(KNOWN_POSTAL_CODE);

    expect(res.statusCode).toBe(HTTP_BAD_GATEWAY);
    expectErrorContract(res.json(), { error: API_ERROR_CODE });
  });

  it('should answer 502 in the standard error shape when the postal code API is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));

    const res = await patchProfile(KNOWN_POSTAL_CODE);

    expect(res.statusCode).toBe(HTTP_BAD_GATEWAY);
    expectErrorContract(res.json(), { error: API_ERROR_CODE });
  });
});
