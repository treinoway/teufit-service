import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

vi.mock('../../src/db.js', () => ({ prisma: {} }));

import { setupApp } from '../helpers/setup-app.js';
import * as authSchemas from '../../api/schemas/auth-route.schema.js';

const SIGNUP_DIRECT_URL = '/auth/signup/direct';
const VALIDATION_ERROR = 'VALIDATION_ERROR';
const VALIDATION_MESSAGE_CODE = 'validation.failed';
const MIN_PASSWORD_LENGTH = 8;
const VALID_PASSWORD = 'StrongPassw0rd!';
const SHORT_PASSWORD = 'a'.repeat(MIN_PASSWORD_LENGTH - 1);
const VALID_BODY = Object.freeze({
  email: 'new.trainer@example.com',
  password: VALID_PASSWORD,
  firstName: 'Bia',
  lastName: 'Souza',
});

// Returns the body without one of its fields.
function without(body, field) {
  const { [field]: _removed, ...rest } = body;
  return rest;
}

describe('POST /auth/signup/direct request contract', () => {
  describe('route schema (signupDirectSchema)', () => {
    const bodySchema = () => authSchemas.signupDirectSchema?.body;

    it('should be exported next to the other signup schemas', () => {
      expect(authSchemas.signupDirectSchema).toEqual(expect.objectContaining({ body: expect.any(Object) }));
    });

    it('should forbid additional properties in the body', () => {
      expect(bodySchema()?.additionalProperties).toBe(false);
    });

    it('should require email, password and firstName, with lastName optional', () => {
      const required = bodySchema()?.required ?? [];

      expect([...required].sort()).toEqual(['email', 'firstName', 'password']);
    });

    it('should accept only email, password, firstName and lastName (no profession, no role)', () => {
      expect(Object.keys(bodySchema()?.properties ?? {}).sort()).toEqual(['email', 'firstName', 'lastName', 'password']);
    });

    it('should require a password of at least 8 characters', () => {
      expect(bodySchema()?.properties?.password?.minLength).toBe(MIN_PASSWORD_LENGTH);
    });

    it('should answer 201 with the same response schema as POST /auth/signup/verify', () => {
      expect(authSchemas.signupDirectSchema?.response?.[201]).toEqual(authSchemas.signupVerifySchema.response[201]);
    });

    it('should document the 400 validation error like POST /auth/signup/verify', () => {
      expect(authSchemas.signupDirectSchema?.response?.[400]).toEqual(authSchemas.signupVerifySchema.response[400]);
    });

    it('should document the 409 conflict with the unified error contract', () => {
      const properties = authSchemas.signupDirectSchema?.response?.[409]?.properties ?? {};

      expect(Object.keys(properties)).toEqual(expect.arrayContaining(['error', 'messageCode', 'message', 'details']));
    });
  });

  describe('request validation', () => {
    let app;

    beforeAll(async () => {
      app = await setupApp();
      await app.ready();
    });

    afterAll(async () => {
      if (app) await app.close();
    });

    const signupDirect = (payload) => app.inject({ method: 'POST', url: SIGNUP_DIRECT_URL, payload });

    it.each([
      ['a password shorter than 8 characters', { ...VALID_BODY, password: SHORT_PASSWORD }, 'password'],
      ['a missing password', without(VALID_BODY, 'password'), 'password'],
      ['a missing email', without(VALID_BODY, 'email'), 'email'],
      ['a malformed email', { ...VALID_BODY, email: 'not-an-email' }, 'email'],
      ['a missing firstName', without(VALID_BODY, 'firstName'), 'firstName'],
      ['an empty firstName', { ...VALID_BODY, firstName: '' }, 'firstName'],
    ])('should answer 400 VALIDATION_ERROR for %s', async (_label, payload, field) => {
      const res = await signupDirect(payload);

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({
        error: VALIDATION_ERROR,
        messageCode: VALIDATION_MESSAGE_CODE,
        message: expect.any(String),
        details: expect.arrayContaining([expect.objectContaining({ field })]),
      });
    });
  });
});
