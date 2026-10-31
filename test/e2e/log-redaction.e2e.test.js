import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { signupVerified } from '../helpers/signup-user.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

const PASSWORD = 'StrongPassw0rd!';
const SECRET_FCM_TOKEN = 'fcm-secret-token-log-redaction-e2e';
const COACH_APP_ID = 'br.com.teufit.coach';
const PLATFORM_ANDROID = 'android';
const HTTP_NO_CONTENT = 204;
const OTHER_ROUTE_URL = '/me/devices';

e2eDescribe('e2e: request log redaction', () => {
  let app;
  let logLines;

  beforeAll(async () => {
    logLines = [];
    const stream = { write: (line) => logLines.push(line) };
    app = await setupApp({ logger: { level: 'info', stream } });
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  beforeEach(async () => {
    await cleanDatabase();
    logLines.length = 0;
  });

  async function createUserToken() {
    const response = await signupVerified(app, {
      method: 'POST',
      url: '/auth/signup',
      payload: { email: `e2e+logs-${Date.now()}@example.com`, password: PASSWORD },
    });
    expect(response.statusCode).toBe(201);
    return response.json().token.accessToken;
  }

  it('should never write the device token to the logs when it is removed', async () => {
    const accessToken = await createUserToken();
    const headers = { authorization: `Bearer ${accessToken}` };
    await app.inject({
      method: 'POST',
      url: OTHER_ROUTE_URL,
      headers,
      payload: { token: SECRET_FCM_TOKEN, platform: PLATFORM_ANDROID, appId: COACH_APP_ID },
    });
    logLines.length = 0;

    const response = await app.inject({
      method: 'DELETE',
      url: `/me/devices/${SECRET_FCM_TOKEN}`,
      headers,
    });

    expect(response.statusCode).toBe(HTTP_NO_CONTENT);
    expect(logLines.length).toBeGreaterThan(0);
    expect(logLines.join('')).not.toContain(SECRET_FCM_TOKEN);
  });

  it('should still log the url of other routes', async () => {
    const accessToken = await createUserToken();
    logLines.length = 0;

    await app.inject({
      method: 'POST',
      url: OTHER_ROUTE_URL,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { token: SECRET_FCM_TOKEN, platform: PLATFORM_ANDROID, appId: COACH_APP_ID },
    });

    expect(logLines.join('')).toContain(`"url":"${OTHER_ROUTE_URL}"`);
  });
});
