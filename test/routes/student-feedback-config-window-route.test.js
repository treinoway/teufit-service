import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

vi.mock('../../src/db.js', () => ({
  prisma: { $disconnect: vi.fn(), trainer: { findUnique: vi.fn() } },
}));

vi.mock('../../src/services/student-feedback-config-service.js', () => ({
  getConfig: vi.fn(),
  updateConfig: vi.fn(),
  getMilestoneTemplates: vi.fn(),
  updateMilestoneTemplates: vi.fn(),
}));

import { buildServer } from '../../api/server.js';
import { getConfigSchema, updateConfigSchema } from '../../api/schemas/student-feedback-route.schema.js';
import { prisma } from '../../src/db.js';
import { Roles } from '../../src/constants/roles.js';
import { RESPONSE_WINDOW_DAYS, RESPONSE_WINDOW_MAX_DAYS, RESPONSE_WINDOW_MIN_DAYS } from '../../src/constants/student-feedback.js';
import { getConfig, updateConfig } from '../../src/services/student-feedback-config-service.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const TRAINER_ID = '22222222-2222-4222-8222-222222222222';

// Booting the whole server cold (imports of every route and plugin) can take far longer than the 10 s default hook timeout on a loaded machine
const SERVER_LIFECYCLE_TIMEOUT_MS = 120000;

const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const VALIDATION_ERROR = 'VALIDATION_ERROR';
const VALIDATION_MESSAGE_CODE = 'validation.failed';
const CONFIG_URL = '/trainer/student-feedbacks/config';
const WINDOW_FIELD = 'responseWindowDays';
const CHOSEN_WINDOW_DAYS = 5;
const SWITCHES = Object.freeze({ autoSendEnabled: true, d7: true, d15: false, d21: true, d30: true, recurring: true });
const STORED_CONFIG = Object.freeze({ ...SWITCHES, responseWindowDays: CHOSEN_WINDOW_DAYS });
const REFUSED_WINDOWS = [
  ['zero', 0],
  ['a negative number', -1],
  ['one above the maximum', 8],
  ['a large number', 100],
  ['a fraction inside the range', 2.5],
  ['a word', 'três'],
  ['a fraction written as text', '2.5'],
  ['null', null],
  ['an object', { days: 3 }],
];

let app = null;
let trainerToken = null;

// Calls the config route as the trainer, with an optional body
function callConfig(method, payload) {
  return app.inject({ method, url: CONFIG_URL, headers: { authorization: `Bearer ${trainerToken}` }, payload });
}

beforeAll(async () => {
  app = await buildServer({ logger: false, adminDb: { $disconnect: vi.fn() } });
  await app.ready();
  trainerToken = app.jwt.sign({ sub: USER_ID, email: 'trainer@example.com', roles: [Roles.TRAINER] });
}, SERVER_LIFECYCLE_TIMEOUT_MS);

afterAll(async () => {
  await app?.close().catch(() => {});
}, SERVER_LIFECYCLE_TIMEOUT_MS);

beforeEach(() => {
  prisma.trainer.findUnique.mockResolvedValue({ id: TRAINER_ID });
  getConfig.mockResolvedValue({ ...STORED_CONFIG });
  updateConfig.mockResolvedValue({ ...STORED_CONFIG });
});

describe('student feedback config route: response window', () => {
  describe('GET /trainer/student-feedbacks/config', () => {
    it('returns the response window of the trainer', async () => {
      const res = await callConfig('GET');

      expect(res.statusCode).toBe(HTTP_OK);
      expect(res.json().responseWindowDays).toBe(CHOSEN_WINDOW_DAYS);
    });

    it('returns the window next to every switch it already returned', async () => {
      const res = await callConfig('GET');

      expect(res.json()).toEqual(STORED_CONFIG);
    });

    it('returns the default window the service reports for a trainer that never saved', async () => {
      getConfig.mockResolvedValue({ ...SWITCHES, autoSendEnabled: false, responseWindowDays: RESPONSE_WINDOW_DAYS });

      const res = await callConfig('GET');

      expect(res.json().responseWindowDays).toBe(RESPONSE_WINDOW_DAYS);
    });

    it('returns the window as a number', async () => {
      const res = await callConfig('GET');

      expect(typeof res.json().responseWindowDays).toBe('number');
    });
  });

  describe('PUT /trainer/student-feedbacks/config', () => {
    it('passes the window to updateConfig and returns the saved config', async () => {
      const res = await callConfig('PUT', { responseWindowDays: CHOSEN_WINDOW_DAYS });

      expect(res.statusCode).toBe(HTTP_OK);
      expect(updateConfig).toHaveBeenCalledWith(prisma, TRAINER_ID, { responseWindowDays: CHOSEN_WINDOW_DAYS }, expect.any(Date));
      expect(res.json()).toEqual(STORED_CONFIG);
    });

    it.each([RESPONSE_WINDOW_MIN_DAYS, RESPONSE_WINDOW_DAYS, RESPONSE_WINDOW_MAX_DAYS])('accepts a window of %i day(s)', async (days) => {
      const res = await callConfig('PUT', { responseWindowDays: days });

      expect(res.statusCode).toBe(HTTP_OK);
      expect(updateConfig).toHaveBeenCalledWith(prisma, TRAINER_ID, { responseWindowDays: days }, expect.any(Date));
    });

    it('passes the window together with the switches sent', async () => {
      const body = { autoSendEnabled: true, d21: false, responseWindowDays: RESPONSE_WINDOW_MAX_DAYS };

      await callConfig('PUT', body);

      expect(updateConfig).toHaveBeenCalledWith(prisma, TRAINER_ID, body, expect.any(Date));
    });

    it('does not invent a window when the body leaves it out', async () => {
      const res = await callConfig('PUT', { d7: false });

      expect(res.statusCode).toBe(HTTP_OK);
      expect(updateConfig).toHaveBeenCalledWith(prisma, TRAINER_ID, { d7: false }, expect.any(Date));
    });

    it.each(REFUSED_WINDOWS)('refuses %s as the window with 400 validation.failed and saves nothing', async (_label, value) => {
      const res = await callConfig('PUT', { responseWindowDays: value });

      expect(res.statusCode).toBe(HTTP_BAD_REQUEST);
      expect(res.json()).toMatchObject({ error: VALIDATION_ERROR, messageCode: VALIDATION_MESSAGE_CODE, message: expect.any(String) });
      expect(Array.isArray(res.json().details)).toBe(true);
      expect(updateConfig).not.toHaveBeenCalled();
    });

    it('refuses an invalid window even when the rest of the body is valid', async () => {
      const res = await callConfig('PUT', { autoSendEnabled: true, responseWindowDays: RESPONSE_WINDOW_MAX_DAYS + 1 });

      expect(res.statusCode).toBe(HTTP_BAD_REQUEST);
      expect(updateConfig).not.toHaveBeenCalled();
    });
  });

  describe('route schema', () => {
    it('declares the window of the body as an integer between the minimum and the maximum', () => {
      expect(updateConfigSchema.body.properties[WINDOW_FIELD]).toMatchObject({ type: 'integer', minimum: RESPONSE_WINDOW_MIN_DAYS, maximum: RESPONSE_WINDOW_MAX_DAYS });
    });

    it('keeps every field of the body optional', () => {
      expect(updateConfigSchema.body.required ?? []).toEqual([]);
    });

    it('keeps refusing unknown fields of the body', () => {
      expect(updateConfigSchema.body.additionalProperties).toBe(false);
    });

    it.each([
      ['GET', getConfigSchema],
      ['PUT', updateConfigSchema],
    ])('declares the window as an integer in the 200 response of %s', (_method, schema) => {
      expect(schema.response[HTTP_OK].properties[WINDOW_FIELD]).toMatchObject({ type: 'integer' });
    });

    it.each(Object.keys(SWITCHES))('keeps the %s switch a boolean in the body and in the response', (field) => {
      expect(updateConfigSchema.body.properties[field]).toEqual({ type: 'boolean' });
      expect(getConfigSchema.response[HTTP_OK].properties[field]).toEqual({ type: 'boolean' });
    });
  });
});
