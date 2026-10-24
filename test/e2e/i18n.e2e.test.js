import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { signupVerified } from '../helpers/signup-user.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

e2eDescribe('e2e: i18n infrastructure', () => {
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
  });

  // ---------------------------------------------------------------------------
  // 404 error — messageCode stability and language selection
  // ---------------------------------------------------------------------------

  it('returns pt-BR 404 message when no app-language header is sent', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/nonexistent-route-for-i18n-test',
    });

    expect(response.statusCode).toBe(404);
    const body = response.json();
    expect(body.messageCode).toBe('resource.notFound');
    expect(body.message).toBe('Recurso não encontrado.');
  });

  it('returns en-US 404 message when app-language: en-US is sent', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/nonexistent-route-for-i18n-test',
      headers: { 'app-language': 'en-US' },
    });

    expect(response.statusCode).toBe(404);
    const body = response.json();
    expect(body.messageCode).toBe('resource.notFound');
    expect(body.message).toBe('Resource not found.');
  });

  it('silently falls back to pt-BR for an unsupported language (fr-FR)', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/nonexistent-route-for-i18n-test',
      headers: { 'app-language': 'fr-FR' },
    });

    expect(response.statusCode).toBe(404);
    const body = response.json();
    expect(body.messageCode).toBe('resource.notFound');
    expect(body.message).toBe('Recurso não encontrado.');
  });

  it('normalizes EN-us to en-US and returns English message', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/nonexistent-route-for-i18n-test',
      headers: { 'app-language': 'EN-us' },
    });

    expect(response.statusCode).toBe(404);
    const body = response.json();
    expect(body.messageCode).toBe('resource.notFound');
    expect(body.message).toBe('Resource not found.');
  });

  // ---------------------------------------------------------------------------
  // Validation errors — messageCode backward compat + translated message
  // ---------------------------------------------------------------------------

  it('returns pt-BR validation message when no app-language header is sent', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: {}, // missing required fields: email and password
      headers: { 'content-type': 'application/json' },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.error).toBe('VALIDATION_ERROR');
    expect(body.messageCode).toBe('validation.failed');
    expect(body.details).toBeInstanceOf(Array);
    expect(body.details.length).toBeGreaterThan(0);

    const firstDetail = body.details[0];
    // messageCode must follow the stable format: validation.{field}.{keyword}
    expect(firstDetail.messageCode).toMatch(/^validation\..+\..+$/);
    // pt-BR message
    expect(firstDetail.message).toContain('obrigatório');
  });

  it('returns en-US validation message when app-language: en-US is sent', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: {}, // missing required fields
      headers: {
        'content-type': 'application/json',
        'app-language': 'en-US',
      },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.error).toBe('VALIDATION_ERROR');
    expect(body.messageCode).toBe('validation.failed');

    const firstDetail = body.details[0];
    // messageCode stays stable regardless of language
    expect(firstDetail.messageCode).toMatch(/^validation\..+\..+$/);
    // en-US message
    expect(firstDetail.message).toContain('required');
  });

  it('keeps messageCode stable for validation errors (backward-compat assertion)', async () => {
    const responsePtBr = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: {},
      headers: { 'content-type': 'application/json' },
    });
    const responseEnUs = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: {},
      headers: {
        'content-type': 'application/json',
        'app-language': 'en-US',
      },
    });

    const ptBrDetail = responsePtBr.json().details[0];
    const enUsDetail = responseEnUs.json().details[0];

    // messageCode must be identical regardless of language
    expect(ptBrDetail.messageCode).toBe(enUsDetail.messageCode);
    // But messages differ
    expect(ptBrDetail.message).not.toBe(enUsDetail.message);
  });

  // ---------------------------------------------------------------------------
  // Swagger compatibility
  // ---------------------------------------------------------------------------

  it('GET /docs/json returns 200 (swagger + x-i18n extension compatibility)', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/docs/json',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toHaveProperty('info');
    expect(body).toHaveProperty('paths');
  });

  // ---------------------------------------------------------------------------
  // Data responses — /me now has *Label fields for roles, status, gender
  // ---------------------------------------------------------------------------

  it('GET /me includes statusLabel and rolesLabel in en-US', async () => {
    const email = `e2e+i18n-${Date.now()}@example.com`;
    const signupResponse = await signupVerified(app, {
      method: 'POST',
      url: '/auth/signup',
      payload: { email, password: 'StrongPassw0rd!' },
    });

    expect(signupResponse.statusCode).toBe(201);
    const { token } = signupResponse.json();

    const meResponse = await app.inject({
      method: 'GET',
      url: '/me',
      headers: {
        authorization: `Bearer ${token.accessToken}`,
        'app-language': 'en-US',
      },
    });

    expect(meResponse.statusCode).toBe(200);
    const meBody = meResponse.json();

    // Verified signup makes the user status='active'; roles start empty
    expect(meBody.status).toBe('active');
    expect(meBody.statusLabel).toBe('Active');
    expect(meBody.roles).toEqual([]);
    expect(meBody.rolesLabel).toEqual([]);
    // gender is null for a new user — label should also be null
    expect(meBody.gender).toBeNull();
    expect(meBody.genderLabel).toBeNull();
  });

  it('GET /me returns pt-BR statusLabel when app-language is pt-BR', async () => {
    const email = `e2e+i18n-ptbr-${Date.now()}@example.com`;
    const signupResponse = await signupVerified(app, {
      method: 'POST',
      url: '/auth/signup',
      payload: { email, password: 'StrongPassw0rd!' },
    });

    expect(signupResponse.statusCode).toBe(201);
    const { token } = signupResponse.json();

    const meResponse = await app.inject({
      method: 'GET',
      url: '/me',
      headers: {
        authorization: `Bearer ${token.accessToken}`,
        'app-language': 'pt-BR',
      },
    });

    expect(meResponse.statusCode).toBe(200);
    const meBody = meResponse.json();

    expect(meBody.status).toBe('active');
    expect(meBody.statusLabel).toBe('Ativo');
  });
});
