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

import emailHandler from '../../src/config/email-handler.js';
import { findUserIdByEmailCaseInsensitive } from '../../src/helpers/email-lookup.js';
import { listPatientInvites, resendPatientInvite } from '../../src/services/patient-invite-service.js';
import { NutritionErrorCode, NutritionMessageCode, PatientInviteStatus } from '../../src/constants/nutrition.js';
import {
  STUDENT_INVITE_TTL_MS as INVITE_TTL_MS,
  STUDENT_INVITE_RESEND_COOLDOWN_MS as RESEND_COOLDOWN_MS,
} from '../../src/constants/student-invite.js';

const NUTRITIONIST_ID = 'nutri-1';
const NUTRITIONIST_USER_ID = 'nutri-user-1';
const INVITE_ID = 'invite-1';
const PATIENT_EMAIL = 'patient@example.com';
const NOW = new Date('2026-11-02T12:00:00.000Z');
const ONE_MINUTE_MS = 60 * 1000;
const HTTP_CONFLICT = 409;
const HTTP_BAD_GATEWAY = 502;
const UNIQUE_VIOLATION = { code: 'P2002' };
const RESEND_ARGS = { nutritionistId: NUTRITIONIST_ID, nutritionistUserId: NUTRITIONIST_USER_ID, inviteId: INVITE_ID };

// Test helper: build a declined invite whose cooldown already elapsed.
function makeDeclinedInvite(overrides = {}) {
  return {
    id: INVITE_ID,
    nutritionistId: NUTRITIONIST_ID,
    email: PATIENT_EMAIL,
    status: PatientInviteStatus.DECLINED,
    expiresAt: new Date(NOW.getTime() - ONE_MINUTE_MS),
    lastSentAt: new Date(NOW.getTime() - RESEND_COOLDOWN_MS - ONE_MINUTE_MS),
    sendCount: 1,
    createdAt: new Date(NOW.getTime() - 2 * RESEND_COOLDOWN_MS),
    ...overrides,
  };
}

// Test helper: build a mocked prisma client.
function makePrisma(invite = makeDeclinedInvite()) {
  return {
    user: { findUnique: vi.fn().mockResolvedValue({ firstName: 'Ana', lastName: 'Nutri', deletedAt: null }) },
    patientInvite: {
      findFirst: vi.fn().mockResolvedValue(invite),
      findUnique: vi.fn().mockResolvedValue({
        ...invite,
        status: PatientInviteStatus.PENDING,
        sendCount: invite.sendCount + 1,
        expiresAt: new Date(NOW.getTime() + INVITE_TTL_MS),
      }),
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  findUserIdByEmailCaseInsensitive.mockResolvedValue(null);
  emailHandler.sendPatientInviteEmail.mockResolvedValue({});
});

afterEach(() => {
  vi.useRealTimers();
});

describe('resendPatientInvite on a declined invite', () => {
  it('should revive the invite to pending with renewed expiry, lastSentAt and sendCount', async () => {
    const prisma = makePrisma();

    await resendPatientInvite(prisma, RESEND_ARGS);

    expect(prisma.patientInvite.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: INVITE_ID, status: PatientInviteStatus.DECLINED }),
      data: {
        status: PatientInviteStatus.PENDING,
        expiresAt: new Date(NOW.getTime() + INVITE_TTL_MS),
        lastSentAt: NOW,
        sendCount: { increment: 1 },
      },
    });
  });

  it('should email the patient and return the revived invite as pending', async () => {
    const prisma = makePrisma();

    const result = await resendPatientInvite(prisma, RESEND_ARGS);

    expect(emailHandler.sendPatientInviteEmail).toHaveBeenCalledWith({ to: PATIENT_EMAIL, nutritionistName: 'Ana Nutri' });
    expect(result.status).toBe(PatientInviteStatus.PENDING);
  });

  it('should still apply the resend cooldown to a declined invite', async () => {
    const prisma = makePrisma(makeDeclinedInvite({ lastSentAt: new Date(NOW.getTime() - ONE_MINUTE_MS) }));

    await expect(resendPatientInvite(prisma, RESEND_ARGS)).rejects.toMatchObject({
      httpStatus: 429,
      messageCode: NutritionMessageCode.INVITE_RESEND_COOLDOWN,
    });
    expect(prisma.patientInvite.updateMany).not.toHaveBeenCalled();
  });

  it('should restore the previous declined status and counters when the email fails', async () => {
    const invite = makeDeclinedInvite();
    const prisma = makePrisma(invite);
    emailHandler.sendPatientInviteEmail.mockResolvedValue({ error: 'smtp down' });

    await expect(resendPatientInvite(prisma, RESEND_ARGS)).rejects.toMatchObject({
      httpStatus: HTTP_BAD_GATEWAY,
      error: NutritionErrorCode.INVITE_EMAIL_SEND_FAILED,
    });

    expect(prisma.patientInvite.updateMany).toHaveBeenLastCalledWith({
      where: { id: INVITE_ID, status: PatientInviteStatus.PENDING, lastSentAt: NOW },
      data: {
        status: PatientInviteStatus.DECLINED,
        expiresAt: invite.expiresAt,
        lastSentAt: invite.lastSentAt,
        sendCount: { decrement: 1 },
      },
    });
  });

  it('should throw 409 alreadyPending when reviving collides with another pending invite for the email', async () => {
    const prisma = makePrisma();
    prisma.patientInvite.updateMany.mockRejectedValue(UNIQUE_VIOLATION);

    await expect(resendPatientInvite(prisma, RESEND_ARGS)).rejects.toMatchObject({
      httpStatus: HTTP_CONFLICT,
      error: NutritionErrorCode.INVITE_ALREADY_PENDING,
      messageCode: NutritionMessageCode.INVITE_ALREADY_PENDING,
    });
    expect(emailHandler.sendPatientInviteEmail).not.toHaveBeenCalled();
  });

  it('should rethrow unexpected database errors from the revive', async () => {
    const prisma = makePrisma();
    const failure = new Error('db down');
    prisma.patientInvite.updateMany.mockRejectedValue(failure);

    await expect(resendPatientInvite(prisma, RESEND_ARGS)).rejects.toBe(failure);
  });

  it.each([PatientInviteStatus.ACCEPTED, PatientInviteStatus.REVOKED, PatientInviteStatus.EXPIRED])(
    'should throw 409 notPending for a %s invite',
    async (status) => {
      const prisma = makePrisma(makeDeclinedInvite({ status }));

      await expect(resendPatientInvite(prisma, RESEND_ARGS)).rejects.toMatchObject({
        httpStatus: HTTP_CONFLICT,
        messageCode: NutritionMessageCode.INVITE_NOT_PENDING,
      });
    },
  );
});

describe('listPatientInvites status filter', () => {
  async function whereFor(status) {
    const prisma = makePrisma();
    await listPatientInvites(prisma, { nutritionistId: NUTRITIONIST_ID, status });
    return prisma.patientInvite.findMany.mock.calls[0][0].where;
  }

  it('should OR the filters of a comma separated status list', async () => {
    const where = await whereFor('pending,declined');

    expect(where).toEqual({
      nutritionistId: NUTRITIONIST_ID,
      OR: [{ status: PatientInviteStatus.PENDING, expiresAt: { gte: NOW } }, { status: PatientInviteStatus.DECLINED }],
    });
  });

  it('should include time-expired pending invites when expired is in the list', async () => {
    const where = await whereFor('expired,declined');

    expect(where.OR[0]).toEqual({
      OR: [{ status: PatientInviteStatus.EXPIRED }, { status: PatientInviteStatus.PENDING, expiresAt: { lt: NOW } }],
    });
  });

  it('should tolerate spaces and drop unknown statuses', async () => {
    const where = await whereFor(' declined , bogus ');

    expect(where).toEqual({ nutritionistId: NUTRITIONIST_ID, status: PatientInviteStatus.DECLINED });
  });

  it('should not filter by status when none of the values is valid', async () => {
    const where = await whereFor('bogus');

    expect(where).toEqual({ nutritionistId: NUTRITIONIST_ID });
  });

  it('should not filter by status when the filter is absent', async () => {
    const where = await whereFor(undefined);

    expect(where).toEqual({ nutritionistId: NUTRITIONIST_ID });
  });

  it('should report canResend false for a declined invite', async () => {
    const prisma = makePrisma();
    prisma.patientInvite.findMany.mockResolvedValue([makeDeclinedInvite()]);

    const { items } = await listPatientInvites(prisma, { nutritionistId: NUTRITIONIST_ID });

    expect(items[0]).toMatchObject({ status: PatientInviteStatus.DECLINED, canResend: false, resendAvailableAt: null });
  });
});
