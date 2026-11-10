import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { signupVerified } from '../helpers/signup-user.js';
import { prisma } from '../../src/db.js';
import {
  createUser,
  createNutritionist,
  createLinkedPatient,
  birthDateForAge,
  uniqueEmail,
  auth,
  expectErrorContract,
  inviteByEmail,
  listMyInvites,
  acceptInvite,
  declineInvite,
  getPlan,
} from '../helpers/nutrition-e2e.js';
import {
  STUDENT_INVITE_RESEND_COOLDOWN_MS as RESEND_COOLDOWN_MS,
  STUDENT_INVITE_MAX_SENDS as MAX_SENDS,
} from '../../src/constants/student-invite.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

const MessageCode = Object.freeze({
  SELF_INVITE: 'nutrition.invite.selfInvite',
  ALREADY_LINKED: 'nutrition.invite.alreadyLinked',
  RESEND_COOLDOWN: 'nutrition.invite.resendCooldown',
  MAX_SENDS: 'nutrition.invite.maxSends',
  NOT_FOUND: 'nutrition.invite.notFound',
  EXPIRED: 'nutrition.invite.expired',
  NOT_PENDING: 'nutrition.invite.notPending',
});
const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';
const PASSWORD = 'StrongPassw0rd!';
const WEIGHT_KG = 66;
const AGE_YEARS = 29;

e2eDescribe('e2e: nutritionist patient invites and patients', () => {
  let app;
  let nutri;

  beforeAll(async () => {
    app = await setupApp();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(async () => {
    await cleanDatabase();
    nutri = await createNutritionist(app);
  });

  function invite(token, email) {
    return app.inject({ method: 'POST', url: '/nutritionist/patient-invites', headers: auth(token), payload: { email } });
  }

  function listInvites(token, status = 'pending') {
    return app.inject({ method: 'GET', url: `/nutritionist/patient-invites?status=${status}`, headers: auth(token) });
  }

  async function createPendingInvite(email = uniqueEmail('invitee')) {
    const res = await invite(nutri.accessToken, email);
    expect(res.statusCode).toBe(201);
    return res.json().invite;
  }

  describe('POST /nutritionist/patient-invites', () => {
    it('should answer 401 without authentication', async () => {
      const res = await app.inject({ method: 'POST', url: '/nutritionist/patient-invites', payload: { email: 'a@b.com' } });

      expect(res.statusCode).toBe(401);
    });

    it('should answer 403 for a user without the nutritionist role', async () => {
      const plain = await createUser(app);

      const res = await invite(plain.accessToken, 'someone@example.com');

      expect(res.statusCode).toBe(403);
    });

    it('should answer 400 VALIDATION_ERROR for an invalid email', async () => {
      const res = await invite(nutri.accessToken, 'not-an-email');

      expectErrorContract(res, { statusCode: 400, error: 'VALIDATION_ERROR', messageCode: 'validation.failed' });
    });

    it('should answer outcome invited with a pending invite for a verified account, never linked', async () => {
      const patient = await createUser(app, 'patient');

      const res = await invite(nutri.accessToken, patient.email.toUpperCase());

      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ outcome: 'invited', invite: { email: patient.email, status: 'pending' } });
      expect(res.json().patient).toBeUndefined();
    });

    it('should answer outcome invited for an existing account whose email is not verified', async () => {
      const patient = await createUser(app, 'patient');
      await prisma.account.updateMany({ where: { userId: patient.userId }, data: { verifiedAt: null } });

      const res = await invite(nutri.accessToken, patient.email);

      expect(res.statusCode).toBe(201);
      expect(res.json().outcome).toBe('invited');
    });

    it('should create no nutritionist-patient link until the patient accepts', async () => {
      const patient = await createUser(app, 'patient');

      await invite(nutri.accessToken, patient.email);

      const patients = await app.inject({ method: 'GET', url: '/nutritionist/patients', headers: auth(nutri.accessToken) });
      expect(patients.json().items).toEqual([]);
      expect(await prisma.nutritionistPatient.count({ where: { patientId: patient.userId } })).toBe(0);
    });

    it('should create a pending invite and answer outcome invited when the email has no account', async () => {
      const email = uniqueEmail('Invitee').toUpperCase();

      const res = await invite(nutri.accessToken, email);

      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({
        outcome: 'invited',
        invite: {
          id: expect.any(String),
          email: email.toLowerCase(),
          status: 'pending',
          expiresAt: expect.any(String),
          lastSentAt: expect.any(String),
          sendCount: 1,
          createdAt: expect.any(String),
        },
      });
    });

    it('should reject inviting the nutritionist own email with 422 nutrition.invite.selfInvite', async () => {
      const res = await invite(nutri.accessToken, nutri.email);

      expectErrorContract(res, { statusCode: 422, messageCode: MessageCode.SELF_INVITE });
    });

    it('should reject an already linked patient with 409 nutrition.invite.alreadyLinked', async () => {
      const patient = await createLinkedPatient(app, nutri);

      const res = await invite(nutri.accessToken, patient.email);

      expectErrorContract(res, { statusCode: 409, messageCode: MessageCode.ALREADY_LINKED });
    });
  });

  describe('GET /nutritionist/patient-invites', () => {
    it('should list pending invites as { items }', async () => {
      const created = await createPendingInvite();

      const res = await listInvites(nutri.accessToken);

      expect(res.statusCode).toBe(200);
      expect(res.json().items).toEqual([expect.objectContaining({ id: created.id, status: 'pending' })]);
    });

    it('should not list invites of another nutritionist', async () => {
      await createPendingInvite();
      const other = await createNutritionist(app);

      const res = await listInvites(other.accessToken);

      expect(res.json().items).toEqual([]);
    });
  });

  describe('POST /nutritionist/patient-invites/:id/resend', () => {
    it('should reject a resend inside the cooldown with 429 nutrition.invite.resendCooldown', async () => {
      const created = await createPendingInvite();

      const res = await app.inject({ method: 'POST', url: `/nutritionist/patient-invites/${created.id}/resend`, headers: auth(nutri.accessToken) });

      const body = expectErrorContract(res, { statusCode: 429, messageCode: MessageCode.RESEND_COOLDOWN });
      expect(body.details.retryAfterSeconds).toBeGreaterThan(0);
    });

    it('should resend after the cooldown and bump sendCount', async () => {
      const created = await createPendingInvite();
      await prisma.patientInvite.update({
        where: { id: created.id },
        data: { lastSentAt: new Date(Date.now() - RESEND_COOLDOWN_MS - 60_000) },
      });

      const res = await app.inject({ method: 'POST', url: `/nutritionist/patient-invites/${created.id}/resend`, headers: auth(nutri.accessToken) });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ id: created.id, sendCount: 2, status: 'pending' });
    });

    it('should reject a resend after the max sends with 409 nutrition.invite.maxSends', async () => {
      const created = await createPendingInvite();
      await prisma.patientInvite.update({
        where: { id: created.id },
        data: { sendCount: MAX_SENDS, lastSentAt: new Date(Date.now() - RESEND_COOLDOWN_MS - 60_000) },
      });

      const res = await app.inject({ method: 'POST', url: `/nutritionist/patient-invites/${created.id}/resend`, headers: auth(nutri.accessToken) });

      expectErrorContract(res, { statusCode: 409, messageCode: MessageCode.MAX_SENDS });
    });

    it('should answer 404 nutrition.invite.notFound for an invite of another nutritionist', async () => {
      const created = await createPendingInvite();
      const other = await createNutritionist(app);

      const res = await app.inject({ method: 'POST', url: `/nutritionist/patient-invites/${created.id}/resend`, headers: auth(other.accessToken) });

      expectErrorContract(res, { statusCode: 404, messageCode: MessageCode.NOT_FOUND });
    });
  });

  describe('DELETE /nutritionist/patient-invites/:id', () => {
    it('should revoke a pending invite with 204 and drop it from the pending list', async () => {
      const created = await createPendingInvite();

      const res = await app.inject({ method: 'DELETE', url: `/nutritionist/patient-invites/${created.id}`, headers: auth(nutri.accessToken) });

      expect(res.statusCode).toBe(204);
      expect((await listInvites(nutri.accessToken)).json().items).toEqual([]);
    });

    it('should answer 404 nutrition.invite.notFound for an unknown invite', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/nutritionist/patient-invites/00000000-0000-4000-8000-000000000000',
        headers: auth(nutri.accessToken),
      });

      expectErrorContract(res, { statusCode: 404, messageCode: MessageCode.NOT_FOUND });
    });

    it('should not link the patient when they sign up after the invite was revoked', async () => {
      const created = await createPendingInvite();
      await app.inject({ method: 'DELETE', url: `/nutritionist/patient-invites/${created.id}`, headers: auth(nutri.accessToken) });

      await signupVerified(app, { method: 'POST', url: '/auth/signup', payload: { email: created.email, password: PASSWORD } });

      const patients = await app.inject({ method: 'GET', url: '/nutritionist/patients', headers: auth(nutri.accessToken) });
      expect(patients.json().items).toEqual([]);
    });
  });

  describe('verifying the email does not accept a nutritionist invite (consent, LGPD)', () => {
    it('should keep the invite pending and create no link when the invitee signs up', async () => {
      const created = await createPendingInvite();

      const signup = await signupVerified(app, { method: 'POST', url: '/auth/signup', payload: { email: created.email, password: PASSWORD } });
      expect(signup.statusCode).toBe(201);

      const patients = await app.inject({ method: 'GET', url: '/nutritionist/patients', headers: auth(nutri.accessToken) });
      expect(patients.json().items).toEqual([]);
      expect((await listInvites(nutri.accessToken)).json().items).toEqual([expect.objectContaining({ id: created.id, status: 'pending' })]);
    });

    it('should let the new account accept the invite afterwards', async () => {
      const created = await createPendingInvite();
      const signup = await signupVerified(app, { method: 'POST', url: '/auth/signup', payload: { email: created.email, password: PASSWORD } });
      const invitee = { userId: signup.json().user.id, accessToken: signup.json().token.accessToken, email: created.email };

      const res = await acceptInvite(app, invitee, created.id);

      expect(res.statusCode).toBe(200);
      const patients = await app.inject({ method: 'GET', url: '/nutritionist/patients', headers: auth(nutri.accessToken) });
      expect(patients.json().items).toEqual([expect.objectContaining({ id: invitee.userId })]);
    });
  });

  describe('GET /my/nutrition/invites', () => {
    it('should answer 401 without authentication', async () => {
      const res = await app.inject({ method: 'GET', url: '/my/nutrition/invites' });

      expect(res.statusCode).toBe(401);
    });

    it('should list the pending invite with the nutritionist name and avatar', async () => {
      const patient = await createUser(app, 'patient');
      const created = (await inviteByEmail(app, nutri, patient.email)).json().invite;

      const res = await listMyInvites(app, patient);

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        items: [
          {
            id: created.id,
            nutritionist: { firstName: expect.any(String), lastName: expect.any(String), avatarUrl: null },
            createdAt: expect.any(String),
            expiresAt: expect.any(String),
          },
        ],
      });
    });

    it('should match the caller email case-insensitively', async () => {
      const patient = await createUser(app, 'patient');
      await inviteByEmail(app, nutri, patient.email.toUpperCase());

      const res = await listMyInvites(app, patient);

      expect(res.json().items).toHaveLength(1);
    });

    it('should not list invites addressed to another email', async () => {
      await createPendingInvite();
      const stranger = await createUser(app, 'stranger');

      const res = await listMyInvites(app, stranger);

      expect(res.json()).toEqual({ items: [] });
    });

    it('should not list an expired invite', async () => {
      const patient = await createUser(app, 'patient');
      const created = (await inviteByEmail(app, nutri, patient.email)).json().invite;
      await prisma.patientInvite.update({ where: { id: created.id }, data: { expiresAt: new Date(Date.now() - 1000) } });

      const res = await listMyInvites(app, patient);

      expect(res.json().items).toEqual([]);
    });

    it('should not list a revoked invite', async () => {
      const patient = await createUser(app, 'patient');
      const created = (await inviteByEmail(app, nutri, patient.email)).json().invite;
      await app.inject({ method: 'DELETE', url: `/nutritionist/patient-invites/${created.id}`, headers: auth(nutri.accessToken) });

      const res = await listMyInvites(app, patient);

      expect(res.json().items).toEqual([]);
    });
  });

  describe('POST /my/nutrition/invites/:id/accept', () => {
    let patient;
    let created;

    beforeEach(async () => {
      patient = await createUser(app, 'patient');
      created = (await inviteByEmail(app, nutri, patient.email)).json().invite;
    });

    it('should answer 401 without authentication', async () => {
      const res = await app.inject({ method: 'POST', url: `/my/nutrition/invites/${created.id}/accept` });

      expect(res.statusCode).toBe(401);
    });

    it('should link the patient, mark the invite accepted and answer { status: accepted }', async () => {
      const res = await acceptInvite(app, patient, created.id);

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: 'accepted' });
      const patients = await app.inject({ method: 'GET', url: '/nutritionist/patients', headers: auth(nutri.accessToken) });
      expect(patients.json().items).toEqual([expect.objectContaining({ id: patient.userId, email: patient.email })]);
      expect((await listInvites(nutri.accessToken, 'accepted')).json().items).toEqual([expect.objectContaining({ id: created.id, status: 'accepted' })]);
    });

    it('should drop the invite from the patient list once accepted', async () => {
      await acceptInvite(app, patient, created.id);

      expect((await listMyInvites(app, patient)).json().items).toEqual([]);
    });

    it('should answer 404 nutrition.invite.notFound for an invite addressed to someone else', async () => {
      const stranger = await createUser(app, 'stranger');

      const res = await acceptInvite(app, stranger, created.id);

      expectErrorContract(res, { statusCode: 404, messageCode: MessageCode.NOT_FOUND });
      expect(await prisma.nutritionistPatient.count()).toBe(0);
    });

    it('should answer 404 nutrition.invite.notFound for an unknown id', async () => {
      const res = await acceptInvite(app, patient, UNKNOWN_ID);

      expectErrorContract(res, { statusCode: 404, messageCode: MessageCode.NOT_FOUND });
    });

    it('should answer 422 nutrition.invite.expired for an expired invite and link nothing', async () => {
      await prisma.patientInvite.update({ where: { id: created.id }, data: { expiresAt: new Date(Date.now() - 1000) } });

      const res = await acceptInvite(app, patient, created.id);

      expectErrorContract(res, { statusCode: 422, messageCode: MessageCode.EXPIRED });
      expect(await prisma.nutritionistPatient.count()).toBe(0);
    });

    it('should answer 422 nutrition.invite.notPending for an already accepted invite', async () => {
      await acceptInvite(app, patient, created.id);

      const res = await acceptInvite(app, patient, created.id);

      expectErrorContract(res, { statusCode: 422, messageCode: MessageCode.NOT_PENDING });
    });

    it('should answer 422 nutrition.invite.notPending for a revoked invite', async () => {
      await app.inject({ method: 'DELETE', url: `/nutritionist/patient-invites/${created.id}`, headers: auth(nutri.accessToken) });

      const res = await acceptInvite(app, patient, created.id);

      expectErrorContract(res, { statusCode: 422, messageCode: MessageCode.NOT_PENDING });
    });

    it('should answer 400 for a malformed invite id', async () => {
      const res = await acceptInvite(app, patient, 'not-a-uuid');

      expectErrorContract(res, { statusCode: 400, error: 'VALIDATION_ERROR', messageCode: 'validation.failed' });
    });
  });

  describe('POST /my/nutrition/invites/:id/decline', () => {
    let patient;
    let created;

    beforeEach(async () => {
      patient = await createUser(app, 'patient');
      created = (await inviteByEmail(app, nutri, patient.email)).json().invite;
    });

    it('should answer 401 without authentication', async () => {
      const res = await app.inject({ method: 'POST', url: `/my/nutrition/invites/${created.id}/decline` });

      expect(res.statusCode).toBe(401);
    });

    it('should mark the invite declined, create no link and answer { status: declined }', async () => {
      const res = await declineInvite(app, patient, created.id);

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: 'declined' });
      expect(await prisma.nutritionistPatient.count()).toBe(0);
    });

    it('should show the nutritionist the invite with status declined', async () => {
      await declineInvite(app, patient, created.id);

      const res = await listInvites(nutri.accessToken, 'declined');

      expect(res.statusCode).toBe(200);
      expect(res.json().items).toEqual([expect.objectContaining({ id: created.id, status: 'declined', canResend: false })]);
    });

    it('should drop the invite from the patient list and from the nutritionist pending list', async () => {
      await declineInvite(app, patient, created.id);

      expect((await listMyInvites(app, patient)).json().items).toEqual([]);
      expect((await listInvites(nutri.accessToken)).json().items).toEqual([]);
    });

    it('should list invites of several statuses with a comma separated status filter', async () => {
      const otherPending = await createPendingInvite();
      await declineInvite(app, patient, created.id);

      const res = await listInvites(nutri.accessToken, 'pending,declined');

      expect(res.statusCode).toBe(200);
      expect(res.json().items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: created.id, status: 'declined' }),
          expect.objectContaining({ id: otherPending.id, status: 'pending' }),
        ]),
      );
      expect(res.json().items).toHaveLength(2);
    });

    it('should not return accepted invites for a pending,declined filter', async () => {
      const accepter = await createUser(app, 'accepter');
      const accepted = (await inviteByEmail(app, nutri, accepter.email)).json().invite;
      await acceptInvite(app, accepter, accepted.id);
      await declineInvite(app, patient, created.id);

      const res = await listInvites(nutri.accessToken, 'pending,declined');

      expect(res.json().items.map((invite) => invite.id)).toEqual([created.id]);
    });

    it('should let the nutritionist invite the same email again after a decline', async () => {
      await declineInvite(app, patient, created.id);

      const res = await inviteByEmail(app, nutri, patient.email);

      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ outcome: 'invited', invite: { status: 'pending' } });
    });

    it('should answer 404 nutrition.invite.notFound for an invite addressed to someone else', async () => {
      const stranger = await createUser(app, 'stranger');

      const res = await declineInvite(app, stranger, created.id);

      expectErrorContract(res, { statusCode: 404, messageCode: MessageCode.NOT_FOUND });
      expect((await listInvites(nutri.accessToken)).json().items).toHaveLength(1);
    });

    it('should answer 422 nutrition.invite.expired for an expired invite', async () => {
      await prisma.patientInvite.update({ where: { id: created.id }, data: { expiresAt: new Date(Date.now() - 1000) } });

      const res = await declineInvite(app, patient, created.id);

      expectErrorContract(res, { statusCode: 422, messageCode: MessageCode.EXPIRED });
    });

    it('should answer 422 nutrition.invite.notPending for an already declined invite', async () => {
      await declineInvite(app, patient, created.id);

      const res = await declineInvite(app, patient, created.id);

      expectErrorContract(res, { statusCode: 422, messageCode: MessageCode.NOT_PENDING });
    });
  });

  describe('data access before the patient accepts (LGPD art. 11)', () => {
    let invitee;

    beforeEach(async () => {
      invitee = await createUser(app, 'invitee');
      await prisma.userHealthDetail.create({ data: { userId: invitee.userId, weight: WEIGHT_KG, height: 165 } });
      await inviteByEmail(app, nutri, invitee.email);
    });

    it.each([
      ['sheet', (id) => `/nutritionist/patients/${id}/sheet`],
      ['overview', (id) => `/nutritionist/patients/${id}/overview`],
      ['plan', (id) => `/nutritionist/patients/${id}/plan`],
      ['training activities', (id) => `/nutritionist/patients/${id}/training-activities`],
    ])('should answer 404 nutrition.patient.notFound on the %s of an invited but not accepted user', async (_label, buildUrl) => {
      const res = await app.inject({ method: 'GET', url: buildUrl(invitee.userId), headers: auth(nutri.accessToken) });

      expectErrorContract(res, { statusCode: 404, messageCode: 'nutrition.patient.notFound' });
    });

    it('should not create a plan row by trying to open the plan', async () => {
      await app.inject({ method: 'GET', url: `/nutritionist/patients/${invitee.userId}/plan`, headers: auth(nutri.accessToken) });

      expect(await prisma.dietProtocol.count({ where: { assigneeId: invitee.userId } })).toBe(0);
    });

    it('should allow the plan once the patient accepts', async () => {
      const [pending] = (await listMyInvites(app, invitee)).json().items;
      await acceptInvite(app, invitee, pending.id);

      const plan = await getPlan(app, nutri, invitee.userId);

      expect(plan.patientId).toBe(invitee.userId);
    });

    it('should lose access again after the patient is unlinked', async () => {
      const [pending] = (await listMyInvites(app, invitee)).json().items;
      await acceptInvite(app, invitee, pending.id);
      await app.inject({ method: 'DELETE', url: `/nutritionist/patients/${invitee.userId}`, headers: auth(nutri.accessToken) });

      const res = await app.inject({ method: 'GET', url: `/nutritionist/patients/${invitee.userId}/sheet`, headers: auth(nutri.accessToken) });

      expect(res.statusCode).toBe(404);
    });
  });

  describe('GET /nutritionist/patients', () => {
    it('should return the PatientRow shape with age, weight and no plan yet', async () => {
      const patient = await createLinkedPatient(app, nutri, { birthDate: birthDateForAge(AGE_YEARS) });
      await prisma.userHealthDetail.create({ data: { userId: patient.userId, weight: WEIGHT_KG, height: 165 } });

      const res = await app.inject({ method: 'GET', url: '/nutritionist/patients', headers: auth(nutri.accessToken) });

      expect(res.statusCode).toBe(200);
      expect(res.json().items).toMatchObject([
        {
          id: patient.userId,
          email: patient.email,
          avatarUrl: null,
          age: AGE_YEARS,
          weightKg: WEIGHT_KG,
          objective: null,
          plan: null,
          adherence7d: null,
          linkedAt: expect.any(String),
        },
      ]);
      expect(Object.keys(res.json().items[0])).toEqual(expect.arrayContaining(['firstName', 'lastName']));
    });

    it('should answer 403 for a user without the nutritionist role', async () => {
      const plain = await createUser(app);

      const res = await app.inject({ method: 'GET', url: '/nutritionist/patients', headers: auth(plain.accessToken) });

      expect(res.statusCode).toBe(403);
    });
  });

  describe('DELETE /nutritionist/patients/:patientId', () => {
    it('should unlink the patient with 204 and drop them from the list', async () => {
      const patient = await createLinkedPatient(app, nutri);

      const res = await app.inject({ method: 'DELETE', url: `/nutritionist/patients/${patient.userId}`, headers: auth(nutri.accessToken) });

      expect(res.statusCode).toBe(204);
      const list = await app.inject({ method: 'GET', url: '/nutritionist/patients', headers: auth(nutri.accessToken) });
      expect(list.json().items).toEqual([]);
    });
  });

  describe('POST /nutritionist/patients (removed)', () => {
    it('should no longer exist: linking is done through patient-invites', async () => {
      const patient = await createUser(app, 'patient');

      const res = await app.inject({ method: 'POST', url: '/nutritionist/patients', headers: auth(nutri.accessToken), payload: { email: patient.email } });

      expect(res.statusCode).toBe(404);
    });
  });
});
