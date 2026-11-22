import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/config/email-handler.js', () => ({
  default: {
    sendStudentInviteEmail: vi.fn(),
    sendExistingUserStudentInviteEmail: vi.fn(),
    sendPatientInviteEmail: vi.fn(),
    sendExistingUserPatientInviteEmail: vi.fn(),
    sendEmailVerificationEmail: vi.fn(),
  },
}));
vi.mock('../../src/services/platform-plan-service.js', () => ({
  assertStudentCap: vi.fn(),
}));
vi.mock('../../src/services/trainer-service.js', () => ({
  linkStudentByEmail: vi.fn(),
}));
vi.mock('../../src/services/trainer-onboarding-service.js', () => ({
  maybeMarkFirstStudentLinked: vi.fn(),
  maybeMarkFirstStudentInvited: vi.fn(),
}));
vi.mock('../../src/services/briefing-service.js', () => ({
  markBriefingDirty: vi.fn(),
}));
vi.mock('../../src/services/challenge-participant-sync.js', () => ({
  joinAllModeChallenges: vi.fn(),
}));
vi.mock('../../src/services/nutritionist-patient-service.js', () => ({
  linkPatientByEmail: vi.fn(),
}));

import { inviteStudent } from '../../src/services/student-invite-service.js';
import { invitePatient } from '../../src/services/patient-invite-service.js';
import { EMAIL_PROVIDER } from '../../src/constants/email-verification.js';
import {
  StudentInviteOutcome,
  StudentInviteErrorCode,
  StudentInviteMessageCode,
  StudentInviteStatus,
  STUDENT_INVITE_DAILY_MAX,
} from '../../src/constants/student-invite.js';
import { NutritionErrorCode, NutritionMessageCode } from '../../src/constants/nutrition.js';

const NOW = new Date('2026-11-18T12:00:00.000Z');
const MS_PER_MINUTE = 60 * 1000;
const MS_PER_DAY = 24 * 60 * MS_PER_MINUTE;
const UNVERIFIED_SENDER_INVITE_CAP = 3;
const SENDER_USER_ID = 'sender-user-1';
const TRAINER_ID = 'trainer-1';
const NUTRITIONIST_ID = 'nutritionist-1';
const DAILY_LIMIT_STATUS = 429;
const EMAIL_VERIFICATION_REQUIRED = Object.freeze({
  httpStatus: 403,
  error: 'EMAIL_VERIFICATION_REQUIRED',
  messageCode: 'emailVerification.required',
});

const COMPARATORS = Object.freeze({
  gte: (value, bound) => value >= bound,
  gt: (value, bound) => value > bound,
  lte: (value, bound) => value <= bound,
  lt: (value, bound) => value < bound,
  not: (value, bound) => value !== bound,
  equals: (value, bound) => value === bound,
  in: (value, bound) => bound.includes(value),
});

// True when a value satisfies a Prisma-style field condition (equality or comparison operators).
function matchesCondition(value, condition) {
  const isOperatorObject = condition !== null && typeof condition === 'object' && !(condition instanceof Date);
  if (!isOperatorObject) return value === condition || (value instanceof Date && condition instanceof Date && value.getTime() === condition.getTime());
  return Object.entries(condition).every(([operator, bound]) => COMPARATORS[operator](value, bound));
}

// True when a row satisfies a Prisma-style where clause (field conditions, AND, OR).
function matchesWhere(row, where = {}) {
  return Object.entries(where).every(([key, condition]) => {
    if (key === 'OR') return condition.some((branch) => matchesWhere(row, branch));
    if (key === 'AND') return [condition].flat().every((branch) => matchesWhere(row, branch));
    return matchesCondition(row[key] ?? null, condition);
  });
}

// In-memory invite table: where clauses are really evaluated, so counting by findMany or count both work.
function createInviteTable(rows) {
  let sequence = rows.length;
  const select = ({ where, orderBy, take } = {}) => {
    const matching = rows.filter((row) => matchesWhere(row, where));
    if (orderBy?.createdAt) matching.sort((a, b) => (orderBy.createdAt === 'desc' ? b.createdAt - a.createdAt : a.createdAt - b.createdAt));
    return take === undefined ? matching : matching.slice(0, take);
  };
  return {
    findMany: vi.fn(async (args) => select(args)),
    findFirst: vi.fn(async (args) => select(args)[0] ?? null),
    count: vi.fn(async (args) => select(args).length),
    updateMany: vi.fn(async ({ where, data }) => ({ count: select({ where }).map((row) => Object.assign(row, data)).length })),
    create: vi.fn(async ({ data }) => {
      sequence += 1;
      const now = new Date();
      const row = { id: `invite-${sequence}`, status: StudentInviteStatus.PENDING, sendCount: 1, lastSentAt: now, createdAt: now, ...data };
      rows.push(row);
      return row;
    }),
  };
}

// In-memory Prisma stand-in for a professional sending invites to emails that have no account.
function createSenderWorld({ senderVerified, studentInvites = [], patientInvites = [] }) {
  const state = { studentInvites: [...studentInvites], patientInvites: [...patientInvites] };
  const senderAccounts = [
    { id: 'account-1', userId: SENDER_USER_ID, provider: EMAIL_PROVIDER, verifiedAt: senderVerified ? new Date('2026-11-01T00:00:00.000Z') : null },
  ];
  const sender = { id: SENDER_USER_ID, email: 'sender@example.com', firstName: 'Ana', lastName: 'Coach', deletedAt: null, accounts: senderAccounts };
  const selectAccounts = ({ where } = {}) => senderAccounts.filter((account) => matchesWhere(account, where));

  const prisma = {
    $queryRaw: vi.fn(async () => []),
    user: { findUnique: vi.fn(async ({ where }) => (where.id === SENDER_USER_ID ? sender : null)) },
    account: {
      findFirst: vi.fn(async (args) => selectAccounts(args)[0] ?? null),
      findMany: vi.fn(async (args) => selectAccounts(args)),
      count: vi.fn(async (args) => selectAccounts(args).length),
    },
    trainer: { findUnique: vi.fn(async () => ({ id: TRAINER_ID, userId: SENDER_USER_ID })) },
    nutritionist: { findUnique: vi.fn(async () => ({ id: NUTRITIONIST_ID, userId: SENDER_USER_ID })) },
    trainerStudent: { findUnique: vi.fn(async () => null) },
    nutritionistPatient: { findUnique: vi.fn(async () => null), findFirst: vi.fn(async () => null) },
    studentInvite: createInviteTable(state.studentInvites),
    patientInvite: createInviteTable(state.patientInvites),
  };
  prisma.$transaction = vi.fn(async (work) => (typeof work === 'function' ? work(prisma) : Promise.all(work)));
  return { prisma, state };
}

// Builds invite rows already sent by the professional, each created `ageMs` ago.
function sentInvites(ownerField, ownerId, count, ageMs) {
  return Array.from({ length: count }, (_unused, index) => ({
    id: `seeded-${index}`,
    [ownerField]: ownerId,
    email: `seeded-${index}@example.com`,
    status: StudentInviteStatus.PENDING,
    sendCount: 1,
    createdAt: new Date(NOW.getTime() - ageMs),
    lastSentAt: new Date(NOW.getTime() - ageMs),
    expiresAt: new Date(NOW.getTime() + MS_PER_DAY),
  }));
}

const SURFACES = [
  {
    name: 'student invites (inviteStudent)',
    table: 'studentInvites',
    otherTable: 'patientInvites',
    ownerField: 'trainerId',
    ownerId: TRAINER_ID,
    otherOwnerField: 'nutritionistId',
    otherOwnerId: NUTRITIONIST_ID,
    sendMethod: 'sendStudentInviteEmail',
    dailyLimit: { error: StudentInviteErrorCode.DAILY_LIMIT, messageCode: StudentInviteMessageCode.DAILY_LIMIT },
    invite: (prisma, email, emailSender) =>
      inviteStudent(prisma, { trainerId: TRAINER_ID, trainerUserId: SENDER_USER_ID, email }, { emailSender }),
  },
  {
    name: 'patient invites (invitePatient)',
    table: 'patientInvites',
    otherTable: 'studentInvites',
    ownerField: 'nutritionistId',
    ownerId: NUTRITIONIST_ID,
    otherOwnerField: 'trainerId',
    otherOwnerId: TRAINER_ID,
    sendMethod: 'sendPatientInviteEmail',
    dailyLimit: { error: NutritionErrorCode.INVITE_DAILY_LIMIT, messageCode: NutritionMessageCode.INVITE_DAILY_LIMIT },
    invite: (prisma, email, emailSender) =>
      invitePatient(prisma, { nutritionistId: NUTRITIONIST_ID, nutritionistUserId: SENDER_USER_ID, email }, { emailSender }),
  },
];

describe.each(SURFACES)('invite cap for senders with an unverified email: $name', (surface) => {
  let emailSender;
  let inviteSequence;

  const nextEmail = () => {
    inviteSequence += 1;
    return `invited-${inviteSequence}@example.com`;
  };
  const recentInvites = (count, ageMs = MS_PER_MINUTE) => sentInvites(surface.ownerField, surface.ownerId, count, ageMs);
  const worldWith = ({ senderVerified, own = [], other = [] }) =>
    createSenderWorld({ senderVerified, [surface.table]: own, [surface.otherTable]: other });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    inviteSequence = 0;
    emailSender = {
      sendStudentInviteEmail: vi.fn().mockResolvedValue({ data: { id: 'message' } }),
      sendExistingUserStudentInviteEmail: vi.fn().mockResolvedValue({ data: { id: 'message' } }),
      sendPatientInviteEmail: vi.fn().mockResolvedValue({ data: { id: 'message' } }),
      sendExistingUserPatientInviteEmail: vi.fn().mockResolvedValue({ data: { id: 'message' } }),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('when the sender email is unverified', () => {
    it('should accept the first three invites sent within 24 hours', async () => {
      const { prisma, state } = worldWith({ senderVerified: false });

      const outcomes = [];
      for (let sent = 0; sent < UNVERIFIED_SENDER_INVITE_CAP; sent += 1) {
        const result = await surface.invite(prisma, nextEmail(), emailSender);
        outcomes.push(result.outcome);
      }

      expect(outcomes).toEqual(Array(UNVERIFIED_SENDER_INVITE_CAP).fill(StudentInviteOutcome.INVITED));
      expect(state[surface.table]).toHaveLength(UNVERIFIED_SENDER_INVITE_CAP);
      expect(emailSender[surface.sendMethod]).toHaveBeenCalledTimes(UNVERIFIED_SENDER_INVITE_CAP);
    });

    it('should reject the fourth invite within 24 hours with 403 EMAIL_VERIFICATION_REQUIRED', async () => {
      const { prisma } = worldWith({ senderVerified: false, own: recentInvites(UNVERIFIED_SENDER_INVITE_CAP) });

      await expect(surface.invite(prisma, nextEmail(), emailSender)).rejects.toMatchObject({
        name: 'AppError',
        ...EMAIL_VERIFICATION_REQUIRED,
      });
    });

    it('should create no invite when the fourth one is rejected', async () => {
      const { prisma, state } = worldWith({ senderVerified: false, own: recentInvites(UNVERIFIED_SENDER_INVITE_CAP) });

      await surface.invite(prisma, nextEmail(), emailSender).catch(() => {});

      expect(state[surface.table]).toHaveLength(UNVERIFIED_SENDER_INVITE_CAP);
    });

    it('should send no email when the fourth one is rejected', async () => {
      const { prisma } = worldWith({ senderVerified: false, own: recentInvites(UNVERIFIED_SENDER_INVITE_CAP) });

      await surface.invite(prisma, nextEmail(), emailSender).catch(() => {});

      expect(emailSender[surface.sendMethod]).not.toHaveBeenCalled();
    });

    it('should still count an invite sent 23 hours 59 minutes ago', async () => {
      const almostOneDay = MS_PER_DAY - MS_PER_MINUTE;
      const { prisma } = worldWith({ senderVerified: false, own: recentInvites(UNVERIFIED_SENDER_INVITE_CAP, almostOneDay) });

      await expect(surface.invite(prisma, nextEmail(), emailSender)).rejects.toMatchObject(EMAIL_VERIFICATION_REQUIRED);
    });

    it('should not count invites sent more than 24 hours ago (rolling window)', async () => {
      const overOneDay = MS_PER_DAY + MS_PER_MINUTE;
      const { prisma } = worldWith({ senderVerified: false, own: recentInvites(UNVERIFIED_SENDER_INVITE_CAP, overOneDay) });

      await expect(surface.invite(prisma, nextEmail(), emailSender)).resolves.toMatchObject({
        outcome: StudentInviteOutcome.INVITED,
      });
    });

    it('should count only its own kind of invite (student and patient caps are separate)', async () => {
      const otherKind = sentInvites(surface.otherOwnerField, surface.otherOwnerId, UNVERIFIED_SENDER_INVITE_CAP, MS_PER_MINUTE);
      const { prisma } = worldWith({ senderVerified: false, other: otherKind });

      await expect(surface.invite(prisma, nextEmail(), emailSender)).resolves.toMatchObject({
        outcome: StudentInviteOutcome.INVITED,
      });
    });
  });

  describe('when the sender email is verified', () => {
    it('should accept the fourth invite within 24 hours', async () => {
      const { prisma, state } = worldWith({ senderVerified: true, own: recentInvites(UNVERIFIED_SENDER_INVITE_CAP) });

      await expect(surface.invite(prisma, nextEmail(), emailSender)).resolves.toMatchObject({
        outcome: StudentInviteOutcome.INVITED,
      });
      expect(state[surface.table]).toHaveLength(UNVERIFIED_SENDER_INVITE_CAP + 1);
    });

    it('should keep applying the existing daily cap with its own error', async () => {
      const { prisma } = worldWith({ senderVerified: true, own: recentInvites(STUDENT_INVITE_DAILY_MAX) });

      await expect(surface.invite(prisma, nextEmail(), emailSender)).rejects.toMatchObject({
        httpStatus: DAILY_LIMIT_STATUS,
        ...surface.dailyLimit,
      });
    });
  });
});
