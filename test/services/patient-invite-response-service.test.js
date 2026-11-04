import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/config/s3-bucket-handler.js', () => ({
  default: { resolveUrl: vi.fn(async (key) => (key ? `https://cdn/${key}` : null)) },
}));

import {
  listInvitesForPatient,
  acceptPatientInvite,
  declinePatientInvite,
} from '../../src/services/patient-invite-response-service.js';
import {
  NutritionErrorCode,
  NutritionMessageCode,
  PatientInviteStatus,
  PatientLinkStatus,
} from '../../src/constants/nutrition.js';

const PATIENT_ID = 'patient-1';
const NUTRITIONIST_ID = 'nutri-1';
const INVITE_ID = 'invite-1';
const PATIENT_EMAIL = 'patient@example.com';
const NOW = new Date('2026-11-02T12:00:00.000Z');
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const HTTP_NOT_FOUND = 404;
const HTTP_UNPROCESSABLE = 422;

// Test helper: build an invite row.
function makeInvite(overrides = {}) {
  return {
    id: INVITE_ID,
    nutritionistId: NUTRITIONIST_ID,
    email: PATIENT_EMAIL,
    status: PatientInviteStatus.PENDING,
    createdAt: new Date(NOW.getTime() - ONE_DAY_MS),
    expiresAt: new Date(NOW.getTime() + ONE_DAY_MS),
    ...overrides,
  };
}

// Test helper: build a mocked prisma client whose transaction runs the callback with itself.
function makePrisma({ user = { email: 'Patient@Example.com', deletedAt: null }, invite = makeInvite(), verifiedAccount = { id: 'account-1' } } = {}) {
  const prisma = {
    account: { findFirst: vi.fn().mockResolvedValue(verifiedAccount) },
    user: { findUnique: vi.fn().mockResolvedValue(user) },
    patientInvite: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(invite),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    nutritionistPatient: { upsert: vi.fn().mockResolvedValue({}) },
  };
  prisma.$transaction = vi.fn(async (callback) => callback(prisma));
  return prisma;
}

// Test helper: asserts the promise rejects with the invite-not-found contract.
async function expectInviteNotFound(promise) {
  await expect(promise).rejects.toMatchObject({
    httpStatus: HTTP_NOT_FOUND,
    error: NutritionErrorCode.INVITE_NOT_FOUND,
    messageCode: NutritionMessageCode.INVITE_NOT_FOUND,
  });
}

// Test helper: asserts the promise rejects with a 422 of the given code.
async function expectUnprocessable(promise, { error, messageCode }) {
  await expect(promise).rejects.toMatchObject({ httpStatus: HTTP_UNPROCESSABLE, error, messageCode });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('listInvitesForPatient', () => {
  it('should return no items when the patient account does not exist', async () => {
    const prisma = makePrisma({ user: null });

    const result = await listInvitesForPatient(prisma, { patientId: PATIENT_ID });

    expect(result).toEqual({ items: [] });
    expect(prisma.patientInvite.findMany).not.toHaveBeenCalled();
  });

  it('should return no items when the patient account is deactivated', async () => {
    const prisma = makePrisma({ user: { email: PATIENT_EMAIL, deletedAt: NOW } });

    const result = await listInvitesForPatient(prisma, { patientId: PATIENT_ID });

    expect(result).toEqual({ items: [] });
  });

  it('should query pending unexpired invites of the lowercased email with an active nutritionist', async () => {
    const prisma = makePrisma();

    await listInvitesForPatient(prisma, { patientId: PATIENT_ID });

    expect(prisma.patientInvite.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          email: PATIENT_EMAIL,
          status: PatientInviteStatus.PENDING,
          expiresAt: { gt: NOW },
          nutritionist: { deletedAt: null },
        },
        orderBy: { createdAt: 'desc' },
      }),
    );
  });

  it('should map the invite with empty names for nulls and a resolved avatar URL', async () => {
    const prisma = makePrisma();
    const row = {
      id: INVITE_ID,
      createdAt: NOW,
      expiresAt: NOW,
      nutritionist: { user: { firstName: null, lastName: 'Silva', avatarUrl: 'avatars/ana.png' } },
    };
    prisma.patientInvite.findMany.mockResolvedValue([row]);

    const result = await listInvitesForPatient(prisma, { patientId: PATIENT_ID });

    expect(result.items).toEqual([
      {
        id: INVITE_ID,
        nutritionist: { firstName: '', lastName: 'Silva', avatarUrl: 'https://cdn/avatars/ana.png' },
        createdAt: NOW,
        expiresAt: NOW,
      },
    ]);
  });
});

describe('acceptPatientInvite', () => {
  it('should throw 404 invite not found when the invite is addressed to another email', async () => {
    const prisma = makePrisma({ invite: null });

    await expectInviteNotFound(acceptPatientInvite(prisma, { patientId: PATIENT_ID, inviteId: INVITE_ID }));
    expect(prisma.patientInvite.findFirst).toHaveBeenCalledWith({
      where: { id: INVITE_ID, email: PATIENT_EMAIL, nutritionist: { deletedAt: null } },
    });
  });

  it('should throw 404 invite not found when the patient account is gone', async () => {
    const prisma = makePrisma({ user: null });

    await expectInviteNotFound(acceptPatientInvite(prisma, { patientId: PATIENT_ID, inviteId: INVITE_ID }));
    expect(prisma.patientInvite.findFirst).not.toHaveBeenCalled();
  });

  it.each([PatientInviteStatus.ACCEPTED, PatientInviteStatus.DECLINED, PatientInviteStatus.REVOKED])(
    'should throw 422 notPending when the invite is %s',
    async (status) => {
      const prisma = makePrisma({ invite: makeInvite({ status }) });

      await expectUnprocessable(acceptPatientInvite(prisma, { patientId: PATIENT_ID, inviteId: INVITE_ID }), {
        error: NutritionErrorCode.INVITE_NOT_PENDING,
        messageCode: NutritionMessageCode.INVITE_NOT_PENDING,
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    },
  );

  it('should throw 422 expired when the pending invite is past its expiry', async () => {
    const prisma = makePrisma({ invite: makeInvite({ expiresAt: new Date(NOW.getTime() - 1) }) });

    await expectUnprocessable(acceptPatientInvite(prisma, { patientId: PATIENT_ID, inviteId: INVITE_ID }), {
      error: NutritionErrorCode.INVITE_EXPIRED,
      messageCode: NutritionMessageCode.INVITE_EXPIRED,
    });
  });

  it('should claim the pending invite and link the nutritionist in one transaction', async () => {
    const prisma = makePrisma();

    const result = await acceptPatientInvite(prisma, { patientId: PATIENT_ID, inviteId: INVITE_ID });

    expect(result).toEqual({ status: PatientInviteStatus.ACCEPTED });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.patientInvite.updateMany).toHaveBeenCalledWith({
      where: { id: INVITE_ID, status: PatientInviteStatus.PENDING },
      data: { status: PatientInviteStatus.ACCEPTED, patientId: PATIENT_ID, acceptedAt: NOW },
    });
  });

  it('should create the link on first accept', async () => {
    const prisma = makePrisma();

    await acceptPatientInvite(prisma, { patientId: PATIENT_ID, inviteId: INVITE_ID });

    expect(prisma.nutritionistPatient.upsert.mock.calls[0][0]).toMatchObject({
      where: { nutritionistId_patientId: { nutritionistId: NUTRITIONIST_ID, patientId: PATIENT_ID } },
      create: { nutritionistId: NUTRITIONIST_ID, patientId: PATIENT_ID },
    });
  });

  it('should reactivate a removed link and refresh createdAt on relink', async () => {
    const prisma = makePrisma();

    await acceptPatientInvite(prisma, { patientId: PATIENT_ID, inviteId: INVITE_ID });

    expect(prisma.nutritionistPatient.upsert.mock.calls[0][0].update).toEqual({
      deletedAt: null,
      status: PatientLinkStatus.ACTIVE,
      createdAt: NOW,
    });
  });

  it('should throw 422 notPending without linking when another request claimed the invite first', async () => {
    const prisma = makePrisma();
    prisma.patientInvite.updateMany.mockResolvedValue({ count: 0 });

    await expectUnprocessable(acceptPatientInvite(prisma, { patientId: PATIENT_ID, inviteId: INVITE_ID }), {
      error: NutritionErrorCode.INVITE_NOT_PENDING,
      messageCode: NutritionMessageCode.INVITE_NOT_PENDING,
    });
    expect(prisma.nutritionistPatient.upsert).not.toHaveBeenCalled();
  });
});

describe('declinePatientInvite', () => {
  it('should throw 404 invite not found when the invite is addressed to another email', async () => {
    const prisma = makePrisma({ invite: null });

    await expectInviteNotFound(declinePatientInvite(prisma, { patientId: PATIENT_ID, inviteId: INVITE_ID }));
  });

  it('should throw 422 notPending when the invite was already answered', async () => {
    const prisma = makePrisma({ invite: makeInvite({ status: PatientInviteStatus.DECLINED }) });

    await expectUnprocessable(declinePatientInvite(prisma, { patientId: PATIENT_ID, inviteId: INVITE_ID }), {
      error: NutritionErrorCode.INVITE_NOT_PENDING,
      messageCode: NutritionMessageCode.INVITE_NOT_PENDING,
    });
  });

  it('should throw 422 expired when the pending invite is past its expiry', async () => {
    const prisma = makePrisma({ invite: makeInvite({ expiresAt: new Date(NOW.getTime() - 1) }) });

    await expectUnprocessable(declinePatientInvite(prisma, { patientId: PATIENT_ID, inviteId: INVITE_ID }), {
      error: NutritionErrorCode.INVITE_EXPIRED,
      messageCode: NutritionMessageCode.INVITE_EXPIRED,
    });
  });

  it('should mark the invite declined without creating any link', async () => {
    const prisma = makePrisma();

    const result = await declinePatientInvite(prisma, { patientId: PATIENT_ID, inviteId: INVITE_ID });

    expect(result).toEqual({ status: PatientInviteStatus.DECLINED });
    expect(prisma.patientInvite.updateMany).toHaveBeenCalledWith({
      where: { id: INVITE_ID, status: PatientInviteStatus.PENDING },
      data: { status: PatientInviteStatus.DECLINED, patientId: PATIENT_ID },
    });
    expect(prisma.nutritionistPatient.upsert).not.toHaveBeenCalled();
  });

  it('should throw 422 notPending when another request answered the invite first', async () => {
    const prisma = makePrisma();
    prisma.patientInvite.updateMany.mockResolvedValue({ count: 0 });

    await expectUnprocessable(declinePatientInvite(prisma, { patientId: PATIENT_ID, inviteId: INVITE_ID }), {
      error: NutritionErrorCode.INVITE_NOT_PENDING,
      messageCode: NutritionMessageCode.INVITE_NOT_PENDING,
    });
  });
});

describe('unverified email', () => {
  it('should return no items for an unverified account', async () => {
    const prisma = makePrisma({ verifiedAccount: null });

    const result = await listInvitesForPatient(prisma, { patientId: PATIENT_ID });

    expect(result).toEqual({ items: [] });
    expect(prisma.patientInvite.findMany).not.toHaveBeenCalled();
  });

  it('should throw 404 invite not found when an unverified account accepts', async () => {
    const prisma = makePrisma({ verifiedAccount: null });

    await expectInviteNotFound(acceptPatientInvite(prisma, { patientId: PATIENT_ID, inviteId: INVITE_ID }));
    expect(prisma.nutritionistPatient.upsert).not.toHaveBeenCalled();
  });

  it('should throw 404 invite not found when an unverified account declines', async () => {
    const prisma = makePrisma({ verifiedAccount: null });

    await expectInviteNotFound(declinePatientInvite(prisma, { patientId: PATIENT_ID, inviteId: INVITE_ID }));
    expect(prisma.patientInvite.updateMany).not.toHaveBeenCalled();
  });
});
