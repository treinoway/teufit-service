import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { prisma } from '../../src/db.js';
import {
  createUser,
  createNutritionist,
  auth,
  expectErrorContract,
  inviteByEmail,
  listMyInvites,
  declineInvite,
} from '../helpers/nutrition-e2e.js';
import { STUDENT_INVITE_RESEND_COOLDOWN_MS as RESEND_COOLDOWN_MS } from '../../src/constants/student-invite.js';
import { PatientInviteStatus } from '../../src/constants/nutrition.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

const MessageCode = Object.freeze({
  RESEND_COOLDOWN: 'nutrition.invite.resendCooldown',
  ALREADY_PENDING: 'nutrition.invite.alreadyPending',
});
const HTTP_OK = 200;
const HTTP_CREATED = 201;
const HTTP_CONFLICT = 409;
const HTTP_TOO_MANY_REQUESTS = 429;
const ONE_MINUTE_MS = 60 * 1000;

e2eDescribe('e2e: resend of a declined patient invite', () => {
  let app;
  let nutri;
  let patient;
  let declined;

  beforeAll(async () => {
    app = await setupApp();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(async () => {
    await cleanDatabase();
    nutri = await createNutritionist(app);
    patient = await createUser(app, 'patient');
    const created = await inviteByEmail(app, nutri, patient.email);
    expect(created.statusCode).toBe(HTTP_CREATED);
    declined = created.json().invite;
    const res = await declineInvite(app, patient, declined.id);
    expect(res.statusCode).toBe(HTTP_OK);
  });

  async function expireCooldown(inviteId) {
    await prisma.patientInvite.update({
      where: { id: inviteId },
      data: { lastSentAt: new Date(Date.now() - RESEND_COOLDOWN_MS - ONE_MINUTE_MS) },
    });
  }

  function resend(inviteId) {
    return app.inject({ method: 'POST', url: `/nutritionist/patient-invites/${inviteId}/resend`, headers: auth(nutri.accessToken) });
  }

  it('should list the invite as declined and not resendable by design', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/nutritionist/patient-invites?status=${PatientInviteStatus.DECLINED}`,
      headers: auth(nutri.accessToken),
    });

    expect(res.statusCode).toBe(HTTP_OK);
    expect(res.json().items[0]).toMatchObject({ id: declined.id, status: PatientInviteStatus.DECLINED, canResend: false });
  });

  it('should revive the declined invite as pending with sendCount 2 after the cooldown', async () => {
    await expireCooldown(declined.id);

    const res = await resend(declined.id);

    expect(res.statusCode, res.body).toBe(HTTP_OK);
    expect(res.json()).toMatchObject({ id: declined.id, status: PatientInviteStatus.PENDING, sendCount: 2 });
  });

  it('should show the revived invite again in the patient invite list', async () => {
    await expireCooldown(declined.id);
    await resend(declined.id);

    const res = await listMyInvites(app, patient);

    expect(res.statusCode).toBe(HTTP_OK);
    expect(res.json().items.map((item) => item.id)).toEqual([declined.id]);
  });

  it('should reject the resend inside the cooldown with 429 and keep the invite declined', async () => {
    const res = await resend(declined.id);

    const body = expectErrorContract(res, { statusCode: HTTP_TOO_MANY_REQUESTS, messageCode: MessageCode.RESEND_COOLDOWN });
    expect(body.details.retryAfterSeconds).toBeGreaterThan(0);
    const row = await prisma.patientInvite.findUnique({ where: { id: declined.id } });
    expect(row.status).toBe(PatientInviteStatus.DECLINED);
  });

  it('should reject reviving with 409 alreadyPending when another pending invite exists for the email', async () => {
    const second = await inviteByEmail(app, nutri, patient.email);
    expect(second.statusCode).toBe(HTTP_CREATED);
    await expireCooldown(declined.id);

    const res = await resend(declined.id);

    expectErrorContract(res, { statusCode: HTTP_CONFLICT, messageCode: MessageCode.ALREADY_PENDING });
    const row = await prisma.patientInvite.findUnique({ where: { id: declined.id } });
    expect(row.status).toBe(PatientInviteStatus.DECLINED);
  });
});
