import 'dotenv/config';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { setupApp } from '../helpers/setup-app.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

const WEB_ORIGIN = 'https://app.teufit.test';
const IOS_APP_ORIGIN = 'capacitor://localhost';
const ANDROID_APP_ORIGIN = 'https://localhost';
const APP_ORIGINS_ENV = 'MOBILE_APP_ORIGINS';
const CORS_ALLOW_ORIGIN_HEADER = 'access-control-allow-origin';

// Sends a CORS preflight for the given origin against a public route.
function preflight(app, origin) {
  return app.inject({
    method: 'OPTIONS',
    url: '/health',
    headers: { origin, 'access-control-request-method': 'GET' },
  });
}

e2eDescribe('e2e: CORS allowlist in production mode', () => {
  let app;
  let previousEnv;

  beforeAll(async () => {
    previousEnv = {
      FRONTEND_URL: process.env.FRONTEND_URL,
      [APP_ORIGINS_ENV]: process.env[APP_ORIGINS_ENV],
    };
    process.env.FRONTEND_URL = WEB_ORIGIN;
    process.env[APP_ORIGINS_ENV] = `${IOS_APP_ORIGIN},${ANDROID_APP_ORIGIN}`;
    app = await setupApp();
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('should keep allowing the configured web origin', async () => {
    const response = await preflight(app, WEB_ORIGIN);

    expect(response.headers[CORS_ALLOW_ORIGIN_HEADER]).toBe(WEB_ORIGIN);
  });

  it('should allow the iOS app origin', async () => {
    const response = await preflight(app, IOS_APP_ORIGIN);

    expect(response.headers[CORS_ALLOW_ORIGIN_HEADER]).toBe(IOS_APP_ORIGIN);
  });

  it('should allow the Android app origin', async () => {
    const response = await preflight(app, ANDROID_APP_ORIGIN);

    expect(response.headers[CORS_ALLOW_ORIGIN_HEADER]).toBe(ANDROID_APP_ORIGIN);
  });

  it('should allow an app origin sent with a trailing slash', async () => {
    const response = await preflight(app, `${IOS_APP_ORIGIN}/`);

    expect(response.headers[CORS_ALLOW_ORIGIN_HEADER]).toBeDefined();
  });

  it('should refuse an unknown origin', async () => {
    const response = await preflight(app, 'https://evil.example.com');

    expect(response.headers[CORS_ALLOW_ORIGIN_HEADER]).toBeUndefined();
  });

  it('should refuse a domain that only starts with the Android app origin', async () => {
    const response = await preflight(app, `${ANDROID_APP_ORIGIN}.evil.example.com`);

    expect(response.headers[CORS_ALLOW_ORIGIN_HEADER]).toBeUndefined();
  });

  it('should refuse a different scheme on the same host as the iOS app origin', async () => {
    const response = await preflight(app, 'http://localhost');

    expect(response.headers[CORS_ALLOW_ORIGIN_HEADER]).toBeUndefined();
  });
});
