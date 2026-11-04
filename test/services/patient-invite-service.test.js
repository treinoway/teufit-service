import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/config/email-handler.js', () => ({
  default: { sendPatientInviteEmail: vi.fn(), sendExistingUserPatientInviteEmail: vi.fn() },
}));
vi.mock('../../src/services/email-verification-service.js', () => ({
  issueCodeRespectingLimits: vi.fn(),
  markVerificationSendFailed: vi.fn(),
  confirmVerificationCodeDelivered: vi.fn(),
  isUserEmailVerified: vi.fn(),
}));
vi.mock('../../src/helpers/email-lookup.js', () => ({ findUserIdByEmailCaseInsensitive: vi.fn() }));
vi.mock('../../src/services/nutritionist-patient-service.js', () => ({ linkPatientByEmail: vi.fn() }));

import emailHandler from '../../src/config/email-handler.js';
import { isUserEmailVerified, issueCodeRespectingLimits } from '../../src/services/email-verification-service.js';
import { findUserIdByEmailCaseInsensitive } from '../../src/helpers/email-lookup.js';
import { linkPatientByEmail } from '../../src/services/nutritionist-patient-service.js';
import {
  invitePatient,
  listPatientInvites,
  resendPatientInvite,
  revokePatientInvite,
} from '../../src/services/patient-invite-service.js';
import {
  STUDENT_INVITE_TTL_MS as INVITE_TTL_MS,
  STUDENT_INVITE_RESEND_COOLDOWN_MS as RESEND_COOLDOWN_MS,
  STUDENT_INVITE_MAX_SENDS as MAX_SENDS,
  STUDENT_INVITE_DAILY_MAX as DAILY_MAX,
} from '../../src/constants/student-invite.js';

const MessageCode = Object.freeze({
  SELF_INVITE: 'nutrition.invite.selfInvite',
  ALREADY_LINKED: 'nutrition.invite.alreadyLinked',
  RESEND_COOLDOWN: 'nutrition.invite.resendCooldown',
  MAX_SENDS: 'nutrition.invite.maxSends',
  DAILY_LIMIT: 'nutrition.invite.dailyLimit',
  NOT_FOUND: 'nutrition.invite.notFound',
});
const Outcome = Object.freeze({ INVITED: 'invited' });
const PENDING = 'pending';
const REVOKED = 'revoked';

const NUTRITIONIST_ID = 'nutri-1';
const NUTRITIONIST_USER_ID = 'nutri-user-1';
const INVITE_ID = 'invite-1';
const PATIENT_EMAIL = 'patient@example.com';
const PATIENT_USER_ID = 'patient-user-1';
const NOW = new Date('2026-11-02T12:00:00.000Z');
const MS_PER_MINUTE = 60 * 1000;

// Test helper: make prisma.
function makePrisma() {
  const prisma = {
    user: { findUnique: vi.fn().mockResolvedValue({ id: PATIENT_USER_ID, email: PATIENT_EMAIL, deletedAt: null, firstName: 'Ana', lastName: 'Nutri' }) },
    patientInvite: {
      create: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      updateMany: vi.fn(),
      count: vi.fn(),
    },
    nutritionistPatient: { findUnique: vi.fn().mockResolvedValue(null), findFirst: vi.fn().mockResolvedValue(null) },
  };
  prisma.$transaction = vi.fn(async (callback) => callback(prisma));
  return prisma;
}

// Test helper: make invite.
function makeInvite(overrides = {}) {
  return {
    id: INVITE_ID,
    nutritionistId: NUTRITIONIST_ID,
    email: PATIENT_EMAIL,
    status: PENDING,
    patientId: null,
    expiresAt: new Date(NOW.getTime() + INVITE_TTL_MS),
    lastSentAt: new Date(NOW.getTime() - RESEND_COOLDOWN_MS - MS_PER_MINUTE),
    sendCount: 1,
    createdAt: new Date(NOW.getTime() - 2 * RESEND_COOLDOWN_MS),
    ...overrides,
  };
}

describe('patient-invite-service', () => {
  let prisma;
  const args = (email = PATIENT_EMAIL) => ({
    nutritionistId: NUTRITIONIST_ID,
    nutritionistUserId: NUTRITIONIST_USER_ID,
    email,
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    prisma = makePrisma();
    findUserIdByEmailCaseInsensitive.mockResolvedValue(null);
    isUserEmailVerified.mockResolvedValue(true);
    issueCodeRespectingLimits.mockResolvedValue(null);
    emailHandler.sendPatientInviteEmail.mockResolvedValue({});
    emailHandler.sendExistingUserPatientInviteEmail.mockResolvedValue({});
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('invitePatient', () => {
    describe('when the email belongs to a verified account (patient consent, LGPD)', () => {
      beforeEach(() => {
        findUserIdByEmailCaseInsensitive.mockResolvedValue(PATIENT_USER_ID);
        isUserEmailVerified.mockResolvedValue(true);
        prisma.patientInvite.create.mockImplementation(async ({ data }) => makeInvite({ ...data }));
      });

      it('should create a pending invite and answer outcome invited instead of linking', async () => {
        const result = await invitePatient(prisma, args());

        expect(result.outcome).toBe(Outcome.INVITED);
        expect(result.invite).toMatchObject({ email: PATIENT_EMAIL, status: PENDING });
      });

      it('should never create the nutritionist-patient link', async () => {
        await invitePatient(prisma, args());

        expect(linkPatientByEmail).not.toHaveBeenCalled();
      });

      it('should not accept or close any invite on behalf of the patient', async () => {
        await invitePatient(prisma, args());

        expect(prisma.patientInvite.updateMany).not.toHaveBeenCalledWith(
          expect.objectContaining({ data: expect.objectContaining({ status: 'accepted' }) }),
        );
      });

      it('should email the invite to the normalized address without issuing a verification code', async () => {
        await invitePatient(prisma, args('Patient@Example.com'));

        const sentTo = [
          ...emailHandler.sendPatientInviteEmail.mock.calls,
          ...emailHandler.sendExistingUserPatientInviteEmail.mock.calls,
        ].map(([payload]) => payload.to);
        expect(sentTo).toEqual([PATIENT_EMAIL]);
        expect(issueCodeRespectingLimits).not.toHaveBeenCalled();
      });

      it('should reject inviting the nutritionist own account with 422 nutrition.invite.selfInvite', async () => {
        findUserIdByEmailCaseInsensitive.mockResolvedValue(NUTRITIONIST_USER_ID);
        prisma.user.findUnique.mockResolvedValue({ id: NUTRITIONIST_USER_ID, email: PATIENT_EMAIL, deletedAt: null });

        await expect(invitePatient(prisma, args())).rejects.toMatchObject({
          httpStatus: 422,
          messageCode: MessageCode.SELF_INVITE,
        });
      });

      it('should reject an already linked patient with 409 nutrition.invite.alreadyLinked', async () => {
        prisma.nutritionistPatient.findUnique.mockResolvedValue({ nutritionistId: NUTRITIONIST_ID });
        prisma.nutritionistPatient.findFirst.mockResolvedValue({ nutritionistId: NUTRITIONIST_ID });

        await expect(invitePatient(prisma, args())).rejects.toMatchObject({
          httpStatus: 409,
          messageCode: MessageCode.ALREADY_LINKED,
        });
      });
    });

    describe('when there is no account for the email', () => {
      beforeEach(() => {
        prisma.patientInvite.create.mockImplementation(async ({ data }) => makeInvite({ ...data, lastSentAt: NOW, sendCount: 1 }));
      });

      it('should create a pending invite with the normalized email and a TTL expiry', async () => {
        await invitePatient(prisma, args('  Patient@Example.COM '));

        expect(prisma.patientInvite.create).toHaveBeenCalledWith({
          data: {
            nutritionistId: NUTRITIONIST_ID,
            email: PATIENT_EMAIL,
            expiresAt: new Date(NOW.getTime() + INVITE_TTL_MS),
          },
        });
      });

      it('should return outcome invited with the pending invite', async () => {
        const result = await invitePatient(prisma, args());

        expect(result.outcome).toBe(Outcome.INVITED);
        expect(result.invite).toMatchObject({ email: PATIENT_EMAIL, status: PENDING });
      });

      it('should send the patient invite email to the normalized address', async () => {
        await invitePatient(prisma, args('Patient@Example.com'));

        expect(emailHandler.sendPatientInviteEmail).toHaveBeenCalledWith(expect.objectContaining({ to: PATIENT_EMAIL }));
      });

      it('should not link anyone', async () => {
        await invitePatient(prisma, args());

        expect(linkPatientByEmail).not.toHaveBeenCalled();
      });

      it('should reject with 429 nutrition.invite.dailyLimit once the daily cap of new invites is reached', async () => {
        prisma.patientInvite.findMany.mockResolvedValue(
          Array.from({ length: DAILY_MAX }, () => ({ createdAt: new Date(NOW.getTime() - MS_PER_MINUTE) })),
        );

        await expect(invitePatient(prisma, args())).rejects.toMatchObject({
          httpStatus: 429,
          messageCode: MessageCode.DAILY_LIMIT,
        });
      });
    });

    describe('when the account exists but the email is unverified', () => {
      beforeEach(() => {
        findUserIdByEmailCaseInsensitive.mockResolvedValue(PATIENT_USER_ID);
        isUserEmailVerified.mockResolvedValue(false);
        prisma.patientInvite.create.mockImplementation(async ({ data }) => makeInvite({ ...data }));
      });

      it('should create a pending invite instead of linking', async () => {
        const result = await invitePatient(prisma, args());

        expect(result.outcome).toBe(Outcome.INVITED);
        expect(linkPatientByEmail).not.toHaveBeenCalled();
      });

      it('should send the existing-user variant email', async () => {
        await invitePatient(prisma, args());

        expect(emailHandler.sendExistingUserPatientInviteEmail).toHaveBeenCalledWith(
          expect.objectContaining({ to: PATIENT_EMAIL }),
        );
      });
    });
  });

  describe('listPatientInvites', () => {
    it('should scope the query to the nutritionist', async () => {
      prisma.patientInvite.findMany.mockResolvedValue([]);
      prisma.patientInvite.count.mockResolvedValue(0);

      await listPatientInvites(prisma, { nutritionistId: NUTRITIONIST_ID });

      expect(prisma.patientInvite.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ nutritionistId: NUTRITIONIST_ID }) }),
      );
    });

    it('should report a time-expired pending invite as expired', async () => {
      prisma.patientInvite.findMany.mockResolvedValue([makeInvite({ expiresAt: new Date(NOW.getTime() - 1000) })]);
      prisma.patientInvite.count.mockResolvedValue(1);

      const { items } = await listPatientInvites(prisma, { nutritionistId: NUTRITIONIST_ID });

      expect(items[0].status).toBe('expired');
    });
  });

  describe('resendPatientInvite', () => {
    const resendArgs = () => ({ nutritionistId: NUTRITIONIST_ID, nutritionistUserId: NUTRITIONIST_USER_ID, inviteId: INVITE_ID });

    it('should reject an unknown invite with 404 nutrition.invite.notFound', async () => {
      prisma.patientInvite.findFirst.mockResolvedValue(null);

      await expect(resendPatientInvite(prisma, resendArgs())).rejects.toMatchObject({
        httpStatus: 404,
        messageCode: MessageCode.NOT_FOUND,
      });
    });

    it('should reject within the cooldown with 429 nutrition.invite.resendCooldown and retryAfterSeconds', async () => {
      prisma.patientInvite.findFirst.mockResolvedValue(makeInvite({ lastSentAt: new Date(NOW.getTime() - 10 * MS_PER_MINUTE) }));

      await expect(resendPatientInvite(prisma, resendArgs())).rejects.toMatchObject({
        httpStatus: 429,
        messageCode: MessageCode.RESEND_COOLDOWN,
        details: { retryAfterSeconds: 50 * 60 },
      });
    });

    it('should reject after the max sends with 409 nutrition.invite.maxSends', async () => {
      prisma.patientInvite.findFirst.mockResolvedValue(makeInvite({ sendCount: MAX_SENDS }));

      await expect(resendPatientInvite(prisma, resendArgs())).rejects.toMatchObject({
        httpStatus: 409,
        messageCode: MessageCode.MAX_SENDS,
      });
    });

    it('should bump sendCount, renew the expiry and resend the email when allowed', async () => {
      const invite = makeInvite();
      prisma.patientInvite.findFirst.mockResolvedValue(invite);
      prisma.patientInvite.updateMany.mockResolvedValue({ count: 1 });
      prisma.patientInvite.findUnique.mockResolvedValue({ ...invite, sendCount: 2, lastSentAt: NOW });

      const result = await resendPatientInvite(prisma, resendArgs());

      expect(prisma.patientInvite.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            expiresAt: new Date(NOW.getTime() + INVITE_TTL_MS),
            lastSentAt: NOW,
            sendCount: { increment: 1 },
          },
        }),
      );
      expect(emailHandler.sendPatientInviteEmail).toHaveBeenCalledWith(expect.objectContaining({ to: PATIENT_EMAIL }));
      expect(result).toMatchObject({ id: INVITE_ID, sendCount: 2 });
    });
  });

  describe('revokePatientInvite', () => {
    it('should mark a pending invite as revoked', async () => {
      prisma.patientInvite.updateMany.mockResolvedValue({ count: 1 });
      prisma.patientInvite.findUnique.mockResolvedValue(makeInvite({ status: REVOKED }));

      const result = await revokePatientInvite(prisma, { nutritionistId: NUTRITIONIST_ID, inviteId: INVITE_ID });

      expect(prisma.patientInvite.updateMany).toHaveBeenCalledWith({
        where: { id: INVITE_ID, nutritionistId: NUTRITIONIST_ID, status: PENDING },
        data: expect.objectContaining({ status: REVOKED }),
      });
      expect(result.status).toBe(REVOKED);
    });

    it('should reject an invite of another nutritionist with 404 nutrition.invite.notFound', async () => {
      prisma.patientInvite.updateMany.mockResolvedValue({ count: 0 });
      prisma.patientInvite.findFirst.mockResolvedValue(null);

      await expect(
        revokePatientInvite(prisma, { nutritionistId: NUTRITIONIST_ID, inviteId: INVITE_ID }),
      ).rejects.toMatchObject({ httpStatus: 404, messageCode: MessageCode.NOT_FOUND });
    });
  });
});
