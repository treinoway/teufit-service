import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/db.js', () => ({ prisma: {} }));
vi.mock('../../src/config/email-handler.js', () => ({
  default: {
    sendStudentInviteEmail: vi.fn(),
    sendExistingUserStudentInviteEmail: vi.fn(),
    sendStudentInviteOpenAppEmail: vi.fn(),
    sendPatientInviteEmail: vi.fn(),
    sendExistingUserPatientInviteEmail: vi.fn(),
    sendEmailVerificationEmail: vi.fn(),
  },
}));
vi.mock('../../src/services/platform-plan-service.js', async (importOriginal) => ({
  ...(await importOriginal()),
  assertStudentCap: vi.fn(),
}));
vi.mock('../../src/services/trainer-onboarding-service.js', async (importOriginal) => ({
  ...(await importOriginal()),
  maybeMarkFirstStudentLinked: vi.fn(),
  maybeMarkFirstStudentInvited: vi.fn(),
}));

import config from '../../config/index.js';
import { inviteStudent } from '../../src/services/student-invite-service.js';
import { invitePatient } from '../../src/services/patient-invite-service.js';
import { EMAIL_PROVIDER } from '../../src/constants/email-verification.js';
import {
  StudentInviteOutcome,
  StudentInviteStatus,
  StudentInviteErrorCode,
  StudentInviteMessageCode,
  STUDENT_INVITE_DAILY_MAX,
} from '../../src/constants/student-invite.js';
import { NutritionErrorCode, NutritionMessageCode } from '../../src/constants/nutrition.js';
import { assertStudentCap } from '../../src/services/platform-plan-service.js';
import { createInviteConsentWorld } from '../helpers/student-invite-consent-world.js';

const MS_PER_MINUTE = 60 * 1000;
const MS_PER_DAY = 24 * 60 * MS_PER_MINUTE;
const ONE_MS = 1;
const FALLBACK_NOW = new Date('2026-12-19T12:00:00.000Z');
const UNVERIFIED_SENDER_INVITE_CAP = 3;
const SENDER_USER_ID = 'sender-user-1';
const TRAINER_ID = 'trainer-1';
const NUTRITIONIST_ID = 'nutritionist-1';
const INVITED_EMAIL = 'invited@example.com';
const DELIVERED = { data: { id: 'message-1' } };
const EMAIL_VERIFICATION_REQUIRED = Object.freeze({
  httpStatus: 403,
  error: 'EMAIL_VERIFICATION_REQUIRED',
  messageCode: 'emailVerification.required',
});

// Instant from which unverified accounts are restricted, read from the configuration under test.
function enforcedFrom() {
  return new Date(config.emailVerification?.enforcedFrom);
}

// Clock of the tests: a month after the cut-off (a fixed date while the cut-off is not configured yet).
function testNow() {
  const cutoff = enforcedFrom().getTime();
  return Number.isNaN(cutoff) ? FALLBACK_NOW : new Date(cutoff + 30 * MS_PER_DAY);
}

// Builds invites the professional already sent a minute ago.
function sentInvites(ownerField, ownerId, count) {
  const sentAt = new Date(Date.now() - MS_PER_MINUTE);
  return Array.from({ length: count }, (_unused, index) => ({
    id: `seeded-${index}`,
    [ownerField]: ownerId,
    email: `seeded-${index}@example.com`,
    status: StudentInviteStatus.PENDING,
    sendCount: 1,
    createdAt: sentAt,
    lastSentAt: sentAt,
    expiresAt: new Date(Date.now() + MS_PER_DAY),
  }));
}

// Builds the world of one professional (trainer and nutritionist) with an UNVERIFIED e-mail created at the given instant.
function makeWorld({ senderCreatedAt, studentInvites = [], patientInvites = [] }) {
  return createInviteConsentWorld({
    users: [{ id: SENDER_USER_ID, email: 'sender@example.com', firstName: 'Ana', lastName: 'Coach', deletedAt: null, createdAt: senderCreatedAt }],
    accounts: [{ id: 'account-1', userId: SENDER_USER_ID, provider: EMAIL_PROVIDER, verifiedAt: null }],
    trainers: [{ id: TRAINER_ID, userId: SENDER_USER_ID, deletedAt: null }],
    nutritionists: [{ id: NUTRITIONIST_ID, userId: SENDER_USER_ID, deletedAt: null }],
    invites: studentInvites,
    patientInvites,
  });
}

const SURFACES = [
  {
    name: 'student invites (inviteStudent)',
    table: 'studentInvites',
    seedKey: 'studentInvites',
    ownerField: 'trainerId',
    ownerId: TRAINER_ID,
    dailyLimit: { error: StudentInviteErrorCode.DAILY_LIMIT, messageCode: StudentInviteMessageCode.DAILY_LIMIT },
    invite: (prisma, emailSender) =>
      inviteStudent(prisma, { trainerId: TRAINER_ID, trainerUserId: SENDER_USER_ID, email: INVITED_EMAIL }, { emailSender }),
  },
  {
    name: 'patient invites (invitePatient)',
    table: 'patientInvites',
    seedKey: 'patientInvites',
    ownerField: 'nutritionistId',
    ownerId: NUTRITIONIST_ID,
    dailyLimit: { error: NutritionErrorCode.INVITE_DAILY_LIMIT, messageCode: NutritionMessageCode.INVITE_DAILY_LIMIT },
    invite: (prisma, emailSender) =>
      invitePatient(prisma, { nutritionistId: NUTRITIONIST_ID, nutritionistUserId: SENDER_USER_ID, email: INVITED_EMAIL }, { emailSender }),
  },
];

describe.each(SURFACES)('unverified-sender invite cap and the open-signup cut-off: $name', (surface) => {
  let emailSender;

  const worldWith = ({ senderCreatedAt, sent }) =>
    makeWorld({ senderCreatedAt, [surface.seedKey]: sentInvites(surface.ownerField, surface.ownerId, sent) });
  const beforeCutoff = () => new Date(enforcedFrom().getTime() - ONE_MS);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(testNow());
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    assertStudentCap.mockResolvedValue(undefined);
    emailSender = {
      sendStudentInviteEmail: vi.fn().mockResolvedValue(DELIVERED),
      sendExistingUserStudentInviteEmail: vi.fn().mockResolvedValue(DELIVERED),
      sendStudentInviteOpenAppEmail: vi.fn().mockResolvedValue(DELIVERED),
      sendPatientInviteEmail: vi.fn().mockResolvedValue(DELIVERED),
      sendExistingUserPatientInviteEmail: vi.fn().mockResolvedValue(DELIVERED),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('when the unverified sender account was created before the cut-off', () => {
    it('should accept the 4th invite within 24 hours', async () => {
      const { prisma, state } = worldWith({ senderCreatedAt: beforeCutoff(), sent: UNVERIFIED_SENDER_INVITE_CAP });

      await expect(surface.invite(prisma, emailSender)).resolves.toMatchObject({ outcome: StudentInviteOutcome.INVITED });
      expect(state[surface.table]).toHaveLength(UNVERIFIED_SENDER_INVITE_CAP + 1);
    });

    it('should keep applying the daily cap with its own error', async () => {
      const { prisma } = worldWith({ senderCreatedAt: beforeCutoff(), sent: STUDENT_INVITE_DAILY_MAX });

      await expect(surface.invite(prisma, emailSender)).rejects.toMatchObject({ httpStatus: 429, ...surface.dailyLimit });
    });
  });

  describe('when the unverified sender account was created at the cut-off', () => {
    it('should reject the 4th invite within 24 hours with 403 emailVerification.required and create nothing', async () => {
      const { prisma, state } = worldWith({ senderCreatedAt: enforcedFrom(), sent: UNVERIFIED_SENDER_INVITE_CAP });

      await expect(surface.invite(prisma, emailSender)).rejects.toMatchObject(EMAIL_VERIFICATION_REQUIRED);
      expect(Number.isNaN(enforcedFrom().getTime())).toBe(false);
      expect(state[surface.table]).toHaveLength(UNVERIFIED_SENDER_INVITE_CAP);
    });

    it('should still accept the 3rd invite', async () => {
      const { prisma } = worldWith({ senderCreatedAt: enforcedFrom(), sent: UNVERIFIED_SENDER_INVITE_CAP - 1 });

      await expect(surface.invite(prisma, emailSender)).resolves.toMatchObject({ outcome: StudentInviteOutcome.INVITED });
    });
  });
});
