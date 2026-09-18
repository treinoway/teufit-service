import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupApp } from '../helpers/setup-app.js';

/**
 * Regression guard for the staging OOM of 2026-09-18: @fastify/session's defaults
 * (saveUninitialized:true over a Map with no eviction) retained ~2.2 KB per cookieless
 * request until the heap ran out. Nothing writes to the session, so the store must
 * stay empty under anonymous traffic.
 *
 * x-forwarded-proto is required: with trustProxy + cookie.secure the plugin skips
 * persisting on a connection it considers insecure, so without it these assertions
 * would pass for the wrong reason.
 */
const HTTPS_PROXY_HEADERS = { 'x-forwarded-proto': 'https' };

describe('session persistence', () => {
  let app;
  let sessionStore;

  beforeAll(async () => {
    app = await setupApp();

    // sessionStore is decorated onto the request, not the instance.
    app.addHook('onRequest', (request, _reply, done) => {
      sessionStore = request.sessionStore;
      done();
    });

    // Routes cannot be added once the instance is listening.
    app.get('/__test/session-write', { config: { rateLimit: false } }, async (request) => {
      request.session.set('oauthRole', 'trainer');
      return { ok: true };
    });

    await app.ready();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it('does not set a session cookie on an anonymous request', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/',
      headers: HTTPS_PROXY_HEADERS,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('retains nothing in the session store across many anonymous requests', async () => {
    for (let i = 0; i < 50; i++) {
      await app.inject({ method: 'GET', url: '/', headers: HTTPS_PROXY_HEADERS });
    }

    expect(sessionStore.store.size).toBe(0);
  });

  it('retains nothing for requests that never match a route', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/definitely-not-a-route',
      headers: HTTPS_PROXY_HEADERS,
    });

    expect(response.statusCode).toBe(404);
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(sessionStore.store.size).toBe(0);
  });

  it('retains nothing for rejected unauthenticated requests to protected routes', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/me',
      headers: HTTPS_PROXY_HEADERS,
    });

    expect(response.statusCode).toBe(401);
    expect(sessionStore.store.size).toBe(0);
  });

  // Guards the Google OAuth handshake, the one flow that needs session state to
  // survive a redirect.
  it('still persists a session once something actually writes to it', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/__test/session-write',
      headers: HTTPS_PROXY_HEADERS,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['set-cookie']).toBeDefined();
    expect(sessionStore.store.size).toBe(1);
  });
});
