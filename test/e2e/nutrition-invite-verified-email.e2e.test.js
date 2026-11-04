import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { prisma } from '../../src/db.js';
import {
  createUser,
  createNutritionist,
  inviteByEmail,
  listMyInvites,
  acceptInvite,
  declineInvite,
  expectErrorContract,
} from '../helpers/nutrition-e2e.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

const NOT_FOUND = 404;
const INVITE_NOT_FOUND_CODE = 'nutrition.invite.notFound';

e2eDescribe('e2e: patient invite response requires a verified email', () => {
  let app;
  let nutri;
  let patient;
  let inviteId;

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
    const invited = await inviteByEmail(app, nutri, patient.email);
    expect(invited.statusCode).toBe(201);
    inviteId = invited.json().invite.id;
    await prisma.account.updateMany({ where: { userId: patient.userId }, data: { verifiedAt: null } });
  });

  it('should list no invites while the account is unverified', async () => {
    const res = await listMyInvites(app, patient);

    expect(res.statusCode).toBe(200);
    expect(res.json().items).toEqual([]);
  });

  it('should answer 404 when an unverified account accepts or declines', async () => {
    const accepted = await acceptInvite(app, patient, inviteId);
    const declined = await declineInvite(app, patient, inviteId);

    expectErrorContract(accepted, { statusCode: NOT_FOUND, messageCode: INVITE_NOT_FOUND_CODE });
    expectErrorContract(declined, { statusCode: NOT_FOUND, messageCode: INVITE_NOT_FOUND_CODE });
    expect(await prisma.nutritionistPatient.count()).toBe(0);
  });

  it('should list and accept the invite after the email is verified', async () => {
    await prisma.account.updateMany({ where: { userId: patient.userId }, data: { verifiedAt: new Date() } });

    const listed = await listMyInvites(app, patient);
    const accepted = await acceptInvite(app, patient, inviteId);

    expect(listed.json().items).toHaveLength(1);
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toEqual({ status: 'accepted' });
  });
});
