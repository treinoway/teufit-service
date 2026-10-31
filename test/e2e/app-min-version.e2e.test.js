import 'dotenv/config';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { setupApp } from '../helpers/setup-app.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

const MIN_VERSIONS_ENV = 'APP_MIN_VERSIONS';
const COACH_APP_ID = 'br.com.teufit.coach';
const UNKNOWN_APP_ID = 'br.com.teufit.unknown';
const PLATFORM_IOS = 'ios';
const PLATFORM_ANDROID = 'android';
const IOS_MIN_VERSION = '1.2.0';
const ANDROID_MIN_VERSION = '1.3.0';
const IOS_STORE_URL = 'https://apps.apple.com/br/app/teufit-coach/id0000000000';
const ANDROID_STORE_URL = 'https://play.google.com/store/apps/details?id=br.com.teufit.coach';
const MIN_VERSIONS_CONFIG = {
  [COACH_APP_ID]: {
    [PLATFORM_IOS]: { minVersion: IOS_MIN_VERSION, storeUrl: IOS_STORE_URL },
    [PLATFORM_ANDROID]: { minVersion: ANDROID_MIN_VERSION, storeUrl: ANDROID_STORE_URL },
  },
};
const VALIDATION_ERROR = 'VALIDATION_ERROR';
const VALIDATION_MESSAGE_CODE = 'validation.failed';

e2eDescribe('e2e: GET /app/min-version', () => {
  let app;
  let previousConfig;

  beforeAll(async () => {
    previousConfig = process.env[MIN_VERSIONS_ENV];
    process.env[MIN_VERSIONS_ENV] = JSON.stringify(MIN_VERSIONS_CONFIG);
    app = await setupApp();
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    if (previousConfig === undefined) delete process.env[MIN_VERSIONS_ENV];
    else process.env[MIN_VERSIONS_ENV] = previousConfig;
  });

  function getMinVersion(query) {
    return app.inject({ method: 'GET', url: `/app/min-version?${query}` });
  }

  it('should return the iOS minimum version and store url without authentication', async () => {
    const response = await getMinVersion(`appId=${COACH_APP_ID}&platform=${PLATFORM_IOS}`);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      appId: COACH_APP_ID,
      platform: PLATFORM_IOS,
      minVersion: IOS_MIN_VERSION,
      storeUrl: IOS_STORE_URL,
    });
  });

  it('should return the Android minimum version and store url', async () => {
    const response = await getMinVersion(`appId=${COACH_APP_ID}&platform=${PLATFORM_ANDROID}`);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      minVersion: ANDROID_MIN_VERSION,
      storeUrl: ANDROID_STORE_URL,
    });
  });

  it('should answer 200 with null minVersion and storeUrl for an unknown app so clients never block', async () => {
    const response = await getMinVersion(`appId=${UNKNOWN_APP_ID}&platform=${PLATFORM_IOS}`);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ minVersion: null, storeUrl: null });
  });

  it('should reject a missing appId with the validation error contract', async () => {
    const response = await getMinVersion(`platform=${PLATFORM_IOS}`);

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: VALIDATION_ERROR,
      messageCode: VALIDATION_MESSAGE_CODE,
    });
  });

  it('should reject a missing platform with the validation error contract', async () => {
    const response = await getMinVersion(`appId=${COACH_APP_ID}`);

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: VALIDATION_ERROR,
      messageCode: VALIDATION_MESSAGE_CODE,
    });
  });

  it('should reject a platform outside ios and android', async () => {
    const response = await getMinVersion(`appId=${COACH_APP_ID}&platform=windows`);

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe(VALIDATION_ERROR);
  });
});
