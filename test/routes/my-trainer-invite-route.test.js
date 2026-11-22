import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

vi.mock('../../src/db.js', () => ({ prisma: {} }));
vi.mock('../../src/services/student-invite-response-service.js', () => ({
  listInvitesForStudent: vi.fn(),
  acceptStudentInvite: vi.fn(),
  declineStudentInvite: vi.fn(),
}));

import { prisma } from '../../src/db.js';
import { setupApp } from '../helpers/setup-app.js';
import { AppError } from '../../src/errors/app-error.js';
import { Roles } from '../../src/constants/roles.js';
import { UserStatus } from '../../src/constants/user-status.js';
import ptBR from '../../src/i18n/locales/pt-BR.js';
import enUS from '../../src/i18n/locales/en-US.js';
import {
  listInvitesForStudent,
  acceptStudentInvite,
  declineStudentInvite,
} from '../../src/services/student-invite-response-service.js';

const USER_ID = '7d0f2b1c-6f0e-4a55-9f0e-0c1d2e3f4a5b';
const USER_EMAIL = 'student@example.com';
const INVITE_ID = '3b1f8a52-4c9e-4d7a-8a55-1f2e3d4c5b6a';
const INVALID_INVITE_ID = 'not-a-uuid';
const LIST_URL = '/my/trainer/invites';
const CREATED_AT = new Date('2026-11-18T09:30:00.000Z');
const EXPIRES_AT = new Date('2026-12-18T09:30:00.000Z');
const ACCEPTED = { status: 'accepted' };
const DECLINED = { status: 'declined' };
const LANGUAGE_HEADER = 'app-language';
const ENGLISH = 'en-US';
const REFUSALS = [
  { httpStatus: 404, error: 'STUDENT_INVITE_NOT_FOUND', messageCode: 'studentInvite.notFound' },
  { httpStatus: 409, error: 'STUDENT_INVITE_NOT_PENDING', messageCode: 'studentInvite.notPending' },
  { httpStatus: 422, error: 'STUDENT_INVITE_EXPIRED', messageCode: 'studentInvite.expired' },
];
const EXPIRED = REFUSALS[2];
const ANSWER_ROUTES = [
  ['accept', acceptStudentInvite, ACCEPTED],
  ['decline', declineStudentInvite, DECLINED],
];
const CALLER_ROLES = [
  ['no role', []],
  ['the trainer role', [Roles.TRAINER]],
  ['the nutritionist role', [Roles.NUTRITIONIST]],
];

// Builds the AppError the response service throws for a refusal.
function refusal({ httpStatus, error, messageCode }) {
  return new AppError({ httpStatus, error, messageCode, message: 'Service fallback message.' });
}

describe('student app routes to answer trainer invites', () => {
  let app;

  const tokenFor = (roles) => app.jwt.sign({ sub: USER_ID, email: USER_EMAIL, roles, status: UserStatus.ACTIVE });
  const auth = (roles = []) => ({ authorization: `Bearer ${tokenFor(roles)}` });
  const answerUrl = (action, inviteId = INVITE_ID) => `${LIST_URL}/${inviteId}/${action}`;

  beforeAll(async () => {
    app = await setupApp();
    await app.ready();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(() => {
    listInvitesForStudent.mockResolvedValue({ items: [] });
    acceptStudentInvite.mockResolvedValue(ACCEPTED);
    declineStudentInvite.mockResolvedValue(DECLINED);
  });

  describe(`GET ${LIST_URL}`, () => {
    it('should answer 401 without authentication and not reach the service', async () => {
      const res = await app.inject({ method: 'GET', url: LIST_URL });

      expect(res.statusCode).toBe(401);
      expect(listInvitesForStudent).not.toHaveBeenCalled();
    });

    it.each(CALLER_ROLES)('should answer 200 for an authenticated user with %s', async (_label, roles) => {
      const res = await app.inject({ method: 'GET', url: LIST_URL, headers: auth(roles) });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ items: [] });
    });

    it('should ask the service for the invites of the authenticated user', async () => {
      await app.inject({ method: 'GET', url: LIST_URL, headers: auth() });

      expect(listInvitesForStudent).toHaveBeenCalledTimes(1);
      expect(listInvitesForStudent).toHaveBeenCalledWith(prisma, { studentId: USER_ID });
    });

    it('should answer each invite as { id, trainer: { firstName, lastName, avatarUrl }, createdAt, expiresAt }', async () => {
      listInvitesForStudent.mockResolvedValue({
        items: [
          {
            id: INVITE_ID,
            trainer: { firstName: 'Ana', lastName: '', avatarUrl: 'https://cdn/avatars/ana.png' },
            createdAt: CREATED_AT,
            expiresAt: EXPIRES_AT,
          },
        ],
      });

      const res = await app.inject({ method: 'GET', url: LIST_URL, headers: auth() });

      expect(res.json()).toEqual({
        items: [
          {
            id: INVITE_ID,
            trainer: { firstName: 'Ana', lastName: '', avatarUrl: 'https://cdn/avatars/ana.png' },
            createdAt: CREATED_AT.toISOString(),
            expiresAt: EXPIRES_AT.toISOString(),
          },
        ],
      });
    });

    it('should answer a null avatarUrl for a trainer without a photo', async () => {
      listInvitesForStudent.mockResolvedValue({
        items: [{ id: INVITE_ID, trainer: { firstName: 'Ana', lastName: 'Coach', avatarUrl: null }, createdAt: CREATED_AT, expiresAt: EXPIRES_AT }],
      });

      const res = await app.inject({ method: 'GET', url: LIST_URL, headers: auth() });

      expect(res.json().items[0].trainer).toEqual({ firstName: 'Ana', lastName: 'Coach', avatarUrl: null });
    });
  });

  describe.each(ANSWER_ROUTES)(`POST ${LIST_URL}/:id/%s`, (action, answerInvite, answered) => {
    const post = (options = {}) => app.inject({ method: 'POST', url: answerUrl(action), headers: auth(), ...options });

    it('should answer 401 without authentication and not reach the service', async () => {
      const res = await post({ headers: {} });

      expect(res.statusCode).toBe(401);
      expect(answerInvite).not.toHaveBeenCalled();
    });

    it.each(CALLER_ROLES)('should answer 200 with the new status for an authenticated user with %s', async (_label, roles) => {
      const res = await post({ headers: auth(roles) });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(answered);
    });

    it('should accept the empty JSON body the mobile app sends', async () => {
      const res = await post({ payload: {} });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(answered);
    });

    it('should hand the authenticated user and the invite id to the service', async () => {
      await post();

      expect(answerInvite).toHaveBeenCalledTimes(1);
      expect(answerInvite).toHaveBeenCalledWith(prisma, { studentId: USER_ID, inviteId: INVITE_ID });
    });

    it('should answer 400 validation.failed for an id that is not a uuid, without reaching the service', async () => {
      const res = await post({ url: answerUrl(action, INVALID_INVITE_ID) });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'VALIDATION_ERROR', messageCode: 'validation.failed' });
      expect(answerInvite).not.toHaveBeenCalled();
    });

    it.each(REFUSALS)('should answer $httpStatus $messageCode in the unified error contract', async (expected) => {
      answerInvite.mockRejectedValue(refusal(expected));

      const res = await post();

      expect(res.statusCode).toBe(expected.httpStatus);
      expect(res.json()).toMatchObject({ error: expected.error, messageCode: expected.messageCode, message: expect.any(String) });
    });

    it('should translate studentInvite.expired to pt-BR by default', async () => {
      answerInvite.mockRejectedValue(refusal(EXPIRED));

      const res = await post();

      expect(ptBR.errors[EXPIRED.messageCode]).toEqual(expect.any(String));
      expect(res.json().message).toBe(ptBR.errors[EXPIRED.messageCode]);
    });

    it('should translate studentInvite.expired to en-US when the app asks for it', async () => {
      answerInvite.mockRejectedValue(refusal(EXPIRED));

      const res = await post({ headers: { ...auth(), [LANGUAGE_HEADER]: ENGLISH } });

      expect(enUS.errors[EXPIRED.messageCode]).toEqual(expect.any(String));
      expect(res.json().message).toBe(enUS.errors[EXPIRED.messageCode]);
    });
  });
});
