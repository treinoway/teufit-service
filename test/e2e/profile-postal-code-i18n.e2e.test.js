import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { signupVerified } from '../helpers/signup-user.js';
import ptBR from '../../src/i18n/locales/pt-BR.js';
import enUS from '../../src/i18n/locales/en-US.js';
import { PostalCodeErrorCode } from '../../src/constants/address.js';

const PASSWORD = 'StrongPassw0rd!';
const KNOWN_POSTAL_CODE = '01310-100';
const UNKNOWN_POSTAL_CODE = '11111-111';
const LEGACY_PREFIX = 'legacy.';
const LANGUAGE_HEADER = 'app-language';
const PT_BR = 'pt-BR';
const EN_US = 'en-US';
const HTTP_NOT_FOUND = 404;
const HTTP_BAD_GATEWAY = 502;

describe('e2e: postal code error messages are translated', () => {
  let app;
  let accessToken;

  const patchProfile = (postalCode, language) =>
    app.inject({
      method: 'PATCH',
      url: '/me/profile',
      headers: { authorization: `Bearer ${accessToken}`, [LANGUAGE_HEADER]: language },
      payload: { address: { line1: 'Rua Teste, 10', city: 'Sao Paulo', postalCode } },
    });

  const getPostalCode = (code, language) =>
    app.inject({
      method: 'GET',
      url: `/postal-code?code=${code}`,
      headers: { authorization: `Bearer ${accessToken}`, [LANGUAGE_HEADER]: language },
    });

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
      payload: { email: `postal-i18n-${Date.now()}@example.com`, password: PASSWORD },
    });
    accessToken = res.json().token.accessToken;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('should return a pt-BR message for an unknown CEP on PATCH /me/profile', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ erro: true }) })));

    const res = await patchProfile(UNKNOWN_POSTAL_CODE, PT_BR);

    expect(res.statusCode).toBe(HTTP_NOT_FOUND);
    expect(res.json().message).toBe(ptBR.errors[`${LEGACY_PREFIX}${PostalCodeErrorCode.NOT_FOUND}`]);
  });

  it('should return a pt-BR message instead of "Internal server error" for a 502 on PATCH /me/profile', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));

    const res = await patchProfile(KNOWN_POSTAL_CODE, PT_BR);

    expect(res.statusCode).toBe(HTTP_BAD_GATEWAY);
    expect(res.json().message).toBe(ptBR.errors[`${LEGACY_PREFIX}${PostalCodeErrorCode.API_ERROR}`]);
    expect(res.json().message).not.toBe('Internal server error');
  });

  it('should return an en-US message when app-language is en-US', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ erro: true }) })));

    const res = await patchProfile(UNKNOWN_POSTAL_CODE, EN_US);

    expect(res.json().message).toBe(enUS.errors[`${LEGACY_PREFIX}${PostalCodeErrorCode.NOT_FOUND}`]);
  });

  it('should return a pt-BR message for an invalid CEP format on GET /postal-code', async () => {
    const res = await getPostalCode('abcdefgh', PT_BR);

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe(ptBR.errors[`${LEGACY_PREFIX}${PostalCodeErrorCode.INVALID_FORMAT}`]);
  });

  it('should return a pt-BR message for a 502 on GET /postal-code', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));

    const res = await getPostalCode('01310100', PT_BR);

    expect(res.statusCode).toBe(HTTP_BAD_GATEWAY);
    expect(res.json().message).toBe(ptBR.errors[`${LEGACY_PREFIX}${PostalCodeErrorCode.API_ERROR}`]);
  });
});
