import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/config/email-handler.js', () => ({
  default: { sendStudentInviteEmail: vi.fn(), sendExistingUserStudentInviteEmail: vi.fn() },
}));
vi.mock('../../src/services/email-verification-service.js', () => ({
  issueCodeRespectingLimits: vi.fn(),
  markVerificationSendFailed: vi.fn(),
  confirmVerificationCodeDelivered: vi.fn(),
  isUserEmailVerified: vi.fn(),
}));
vi.mock('../../src/helpers/email-lookup.js', () => ({ findUserIdByEmailCaseInsensitive: vi.fn() }));
vi.mock('../../src/services/platform-plan-service.js', () => ({ assertStudentCap: vi.fn() }));
vi.mock('../../src/services/trainer-service.js', () => ({ linkStudentByEmail: vi.fn() }));
vi.mock('../../src/services/trainer-onboarding-service.js', () => ({
  maybeMarkFirstStudentLinked: vi.fn(),
  maybeMarkFirstStudentInvited: vi.fn(),
}));
vi.mock('../../src/services/briefing-service.js', () => ({ markBriefingDirty: vi.fn() }));

import { acceptPendingInvitesForUser } from '../../src/services/student-invite-service.js';

const NOW = new Date('2026-11-02T12:00:00.000Z');
const PATIENT_ID = 'patient-1';
const user = { id: PATIENT_ID, email: 'Patient@Example.com' };

// Test helper: make prisma.
function makePrisma() {
  const prisma = {
    user: { findUnique: vi.fn(), update: vi.fn().mockResolvedValue({}), updateMany: vi.fn() },
    studentInvite: { findMany: vi.fn().mockResolvedValue([]), updateMany: vi.fn() },
    trainerStudent: { createMany: vi.fn() },
    patientInvite: { findMany: vi.fn().mockResolvedValue([]), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    nutritionistPatient: {
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
      upsert: vi.fn().mockResolvedValue({}),
      create: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
  prisma.$transaction = vi.fn(async (callback) => callback(prisma));
  return prisma;
}

// Test helper: every write the function could make on patient invites or links.
function patientConsentWrites(prisma) {
  const { createMany, upsert, create, update, updateMany } = prisma.nutritionistPatient;
  return [
    ...createMany.mock.calls,
    ...upsert.mock.calls,
    ...create.mock.calls,
    ...update.mock.calls,
    ...updateMany.mock.calls,
    ...prisma.patientInvite.updateMany.mock.calls,
  ];
}

describe('acceptPendingInvitesForUser (patient invites need explicit consent, not email verification)', () => {
  let prisma;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    prisma = makePrisma();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should not read patient invites when the email gets verified', async () => {
    await acceptPendingInvitesForUser(prisma, user);

    expect(prisma.patientInvite.findMany).not.toHaveBeenCalled();
  });

  it('should not accept, expire or link anything on the patient side', async () => {
    prisma.patientInvite.findMany.mockResolvedValue([{ id: 'patient-invite-1', nutritionistId: 'nutri-1', expiresAt: new Date(NOW.getTime() + 1000) }]);

    const accepted = await acceptPendingInvitesForUser(prisma, user);

    expect(accepted).toBe(0);
    expect(patientConsentWrites(prisma)).toEqual([]);
  });

  it('should keep accepting student invites', async () => {
    prisma.studentInvite.findMany.mockResolvedValue([]);

    await expect(acceptPendingInvitesForUser(prisma, user)).resolves.toBe(0);
    expect(prisma.studentInvite.findMany).toHaveBeenCalled();
  });

  it('should never throw even when the patient invite table is unavailable', async () => {
    prisma.patientInvite = undefined;

    await expect(acceptPendingInvitesForUser(prisma, user)).resolves.toBe(0);
  });
});
