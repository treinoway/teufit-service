import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock platform-plan-service — gating is tested separately
vi.mock('../../src/services/platform-plan-service.js', () => ({
  assertStudentCap: vi.fn().mockResolvedValue(undefined),
}));

// Mock Prisma client used by trainerService
vi.mock('../../src/db.js', () => {
  return {
    prisma: {
      $transaction: vi.fn(),
      $queryRaw: vi.fn(),
      trainer: {
        findMany: vi.fn(),
        findUnique: vi.fn(),
        updateMany: vi.fn(),
      },
      user: {
        findUnique: vi.fn(),
      },
      trainerStudent: {
        findUnique: vi.fn(),
        findMany: vi.fn(),
        create: vi.fn(),
        delete: vi.fn(),
      },
      trainingProtocol: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      workoutSession: {
        groupBy: vi.fn().mockResolvedValue([]),
      },
      studentSubscription: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      subscriptionPayment: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      trainerBriefingSnapshot: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    },
  };
});

vi.mock('../../src/config/s3-bucket-handler.js', () => ({
  default: {
    resolveUrl: vi.fn(),
  },
}));

// Mock the email handler — sending is fire-and-forget and tested via the mock.
vi.mock('../../src/config/email-handler.js', () => ({
  default: {
    sendStudentLinkedEmail: vi.fn().mockResolvedValue(undefined),
  },
}));

import { prisma } from '../../src/db.js';
import s3BucketHandler from '../../src/config/s3-bucket-handler.js';
import emailHandler from '../../src/config/email-handler.js';
import { updateMyTrainerProfile, linkStudentByEmail, listStudents, listTrainers, searchStudents, unlinkStudent, getOneByUserId, computeStudentBlockers } from '../../src/services/trainer-service.js';
import { assertStudentCap } from '../../src/services/platform-plan-service.js';
import { StudentBlocker } from '../../src/constants/student-blocker.js';
import { SubscriptionStatus } from '../../src/constants/subscription.js';

describe('trainerService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-apply platform-plan-service mocks after mockReset (mockReset: true in vitest config).
    assertStudentCap.mockResolvedValue(undefined);
    s3BucketHandler.resolveUrl.mockResolvedValue(null);
    prisma.trainer.updateMany.mockResolvedValue({ count: 0 });
  });

  it('throws NO_UPDATES when nothing is provided', async () => {
    await expect(updateMyTrainerProfile({ userId: 'u1' })).rejects.toMatchObject({
      code: 'NO_UPDATES',
      statusCode: 400,
    });

    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('throws TRAINER_PROFILE_MISSING when trainer row does not exist', async () => {
    prisma.$transaction.mockImplementation(async (fn) => {
      const tx = {
        trainer: { findUnique: vi.fn().mockResolvedValue(null) },
      };
      return fn(tx);
    });

    await expect(
      updateMyTrainerProfile({
        userId: 'u1',
        trainer: { firstName: 'A' },
      }),
    ).rejects.toMatchObject({
      code: 'TRAINER_PROFILE_MISSING',
      statusCode: 409,
    });
  });

  it('updates trainer, upserts address + socials, and activates user', async () => {
    prisma.$transaction.mockImplementation(async (fn) => {
      const tx = {
        trainer: {
          findUnique: vi.fn().mockResolvedValue({ id: 't1', userId: 'u1' }),
          update: vi.fn().mockResolvedValue({ id: 't1', userId: 'u1', professionalDocument: 'ABC' }),
        },
        address: {
          upsert: vi.fn().mockResolvedValue({ id: 'a1', userId: 'u1' }),
        },
        socialNetwork: {
          upsert: vi.fn().mockResolvedValue({ id: 's1', userId: 'u1' }),
        },
        user: {
          update: vi.fn().mockResolvedValue({ id: 'u1', status: 'active', firstName: 'Ana' }),
        },
      };

      const res = await fn(tx);

      // quick assertions inside fake tx call
      expect(tx.trainer.findUnique).toHaveBeenCalledWith({ where: { userId: 'u1' } });
      expect(tx.trainer.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 't1' },
          data: expect.objectContaining({ professionalDocument: 'ABC' }),
        }),
      );
      expect(tx.address.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: 'u1' },
          create: expect.objectContaining({ userId: 'u1' }),
          update: expect.any(Object),
        }),
      );
      expect(tx.socialNetwork.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: 'u1' },
          create: expect.objectContaining({ userId: 'u1' }),
          update: expect.any(Object),
        }),
      );
      expect(tx.user.update).toHaveBeenCalledWith({
        where: { id: 'u1' },
        data: expect.objectContaining({ status: 'active' }),
      });

      return res;
    });

    const res = await updateMyTrainerProfile({
      userId: 'u1',
      trainer: { firstName: 'Ana', professionalDocument: 'ABC' },
      address: {
        line1: 'Main St',
        city: 'NY',
        country: 'US',
      },
      socials: {
        instagram: '@ana',
      },
    });

    expect(res).toEqual({
      id: 't1',
      professionalDocument: 'ABC',
      firstName: 'Ana',
      lastName: undefined,
      birthDate: null,
      avatarUrl: null,
      address: { id: 'a1', userId: 'u1' },
      socialNetworks: { id: 's1', userId: 'u1' },
    });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('validates serviceMode contains only valid values', async () => {
    prisma.$transaction.mockImplementation(async (fn) => {
      const tx = {
        trainer: {
          findUnique: vi.fn().mockResolvedValue({ id: 't1', userId: 'u1' }),
        },
      };
      return fn(tx);
    });

    await expect(
      updateMyTrainerProfile({
        userId: 'u1',
        trainer: { serviceMode: 'invalid' },
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_SERVICE_MODE',
      statusCode: 400,
    });
  });

  it('accepts valid serviceMode', async () => {
    prisma.$transaction.mockImplementation(async (fn) => {
      const tx = {
        trainer: {
          findUnique: vi.fn().mockResolvedValue({ id: 't1', userId: 'u1' }),
          update: vi.fn().mockResolvedValue({ id: 't1', userId: 'u1', serviceMode: 'online' }),
        },
        user: {
          update: vi.fn().mockResolvedValue({ id: 'u1', status: 'active', firstName: 'Ana' }),
        },
      };
      return fn(tx);
    });

    const res = await updateMyTrainerProfile({
      userId: 'u1',
      trainer: { serviceMode: 'online', firstName: 'Ana' },
    });

    expect(res).toEqual({
      id: 't1',
      serviceMode: 'online',
      firstName: 'Ana',
      lastName: undefined,
      birthDate: null,
      avatarUrl: null,
      address: null,
      socialNetworks: null,
    });
  });
});

describe('linkStudentByEmail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    s3BucketHandler.resolveUrl.mockResolvedValue(null);
    emailHandler.sendStudentLinkedEmail.mockResolvedValue(undefined);
  });

  it('throws student.notFound when no user exists with the given email', async () => {
    prisma.user.findUnique.mockResolvedValue(null);

    await expect(
      linkStudentByEmail({ trainerId: 'trainer1', trainerUserId: 'user-trainer', email: 'unknown@example.com' }),
    ).rejects.toMatchObject({
      error: 'NOT_FOUND',
      messageCode: 'student.notFound',
      httpStatus: 404,
    });

    expect(prisma.trainerStudent.findUnique).not.toHaveBeenCalled();
  });

  it('throws student.cannotLinkSelf when trainer tries to link themselves', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-trainer',
      email: 'trainer@example.com',
      firstName: 'John',
      lastName: 'Trainer',
      avatarUrl: null,
    });

    await expect(
      linkStudentByEmail({ trainerId: 'trainer1', trainerUserId: 'user-trainer', email: 'trainer@example.com' }),
    ).rejects.toMatchObject({
      error: 'CANNOT_LINK_SELF',
      messageCode: 'student.cannotLinkSelf',
      httpStatus: 422,
    });

    expect(prisma.trainerStudent.findUnique).not.toHaveBeenCalled();
  });

  it('throws student.alreadyLinked when student is already linked to the trainer', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-student',
      email: 'student@example.com',
      firstName: 'Jane',
      lastName: 'Doe',
      avatarUrl: null,
    });
    prisma.trainerStudent.findUnique.mockResolvedValue({ id: 'link1', trainerId: 'trainer1', studentId: 'user-student' });

    await expect(
      linkStudentByEmail({ trainerId: 'trainer1', trainerUserId: 'user-trainer', email: 'student@example.com' }),
    ).rejects.toMatchObject({
      error: 'CONFLICT',
      messageCode: 'student.alreadyLinked',
      httpStatus: 409,
    });

    expect(prisma.trainerStudent.create).not.toHaveBeenCalled();
  });

  it('creates the link and returns student profile on success', async () => {
    // First findUnique resolves the student (by email), second resolves the trainer (by id).
    prisma.user.findUnique
      .mockResolvedValueOnce({
        id: 'user-student',
        email: 'student@example.com',
        firstName: 'Jane',
        lastName: 'Doe',
        avatarUrl: 's3://some-key',
      })
      .mockResolvedValueOnce({ firstName: 'John', lastName: 'Trainer' });
    prisma.trainerStudent.findUnique.mockResolvedValue(null);
    prisma.trainerStudent.create.mockResolvedValue({ id: 'link1', trainerId: 'trainer1', studentId: 'user-student' });
    s3BucketHandler.resolveUrl.mockResolvedValue('https://cdn.example.com/avatar.jpg');

    const result = await linkStudentByEmail({
      trainerId: 'trainer1',
      trainerUserId: 'user-trainer',
      email: 'student@example.com',
    });

    expect(prisma.trainerStudent.create).toHaveBeenCalledWith({
      data: { trainerId: 'trainer1', studentId: 'user-student' },
    });

    expect(result).toEqual({
      id: 'user-student',
      email: 'student@example.com',
      firstName: 'Jane',
      lastName: 'Doe',
      avatarUrl: 'https://cdn.example.com/avatar.jpg',
    });
  });

  it('sends a student-linked email with the trainer name on success', async () => {
    prisma.user.findUnique
      .mockResolvedValueOnce({
        id: 'user-student',
        email: 'student@example.com',
        firstName: 'Jane',
        lastName: 'Doe',
        avatarUrl: null,
      })
      .mockResolvedValueOnce({ firstName: 'John', lastName: 'Trainer' });
    prisma.trainerStudent.findUnique.mockResolvedValue(null);
    prisma.trainerStudent.create.mockResolvedValue({ id: 'link1' });

    await linkStudentByEmail({
      trainerId: 'trainer1',
      trainerUserId: 'user-trainer',
      email: 'student@example.com',
    });

    expect(emailHandler.sendStudentLinkedEmail).toHaveBeenCalledWith({
      to: 'student@example.com',
      trainerName: 'John Trainer',
    });
  });

  it('falls back to an empty trainerName when the trainer has no name set', async () => {
    prisma.user.findUnique
      .mockResolvedValueOnce({
        id: 'user-student',
        email: 'student@example.com',
        firstName: 'Jane',
        lastName: 'Doe',
        avatarUrl: null,
      })
      .mockResolvedValueOnce({ firstName: null, lastName: null });
    prisma.trainerStudent.findUnique.mockResolvedValue(null);
    prisma.trainerStudent.create.mockResolvedValue({ id: 'link1' });

    await linkStudentByEmail({
      trainerId: 'trainer1',
      trainerUserId: 'user-trainer',
      email: 'student@example.com',
    });

    expect(emailHandler.sendStudentLinkedEmail).toHaveBeenCalledWith({
      to: 'student@example.com',
      trainerName: '',
    });
  });

  it('still links the student when the email send fails', async () => {
    prisma.user.findUnique
      .mockResolvedValueOnce({
        id: 'user-student',
        email: 'student@example.com',
        firstName: 'Jane',
        lastName: 'Doe',
        avatarUrl: null,
      })
      .mockResolvedValueOnce({ firstName: 'John', lastName: 'Trainer' });
    prisma.trainerStudent.findUnique.mockResolvedValue(null);
    prisma.trainerStudent.create.mockResolvedValue({ id: 'link1' });
    emailHandler.sendStudentLinkedEmail.mockRejectedValueOnce(new Error('resend down'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await linkStudentByEmail({
      trainerId: 'trainer1',
      trainerUserId: 'user-trainer',
      email: 'student@example.com',
    });

    expect(prisma.trainerStudent.create).toHaveBeenCalledWith({
      data: { trainerId: 'trainer1', studentId: 'user-student' },
    });
    expect(result).toMatchObject({ id: 'user-student', email: 'student@example.com' });
    consoleSpy.mockRestore();
  });

  it('does not send an email when the link fails validation', async () => {
    prisma.user.findUnique.mockResolvedValue(null);

    await expect(
      linkStudentByEmail({ trainerId: 'trainer1', trainerUserId: 'user-trainer', email: 'unknown@example.com' }),
    ).rejects.toMatchObject({ messageCode: 'student.notFound' });

    expect(emailHandler.sendStudentLinkedEmail).not.toHaveBeenCalled();
  });
});

describe('listTrainers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    s3BucketHandler.resolveUrl.mockResolvedValue(null);
  });

  it('returns an empty array when no active trainers exist', async () => {
    prisma.trainer.findMany.mockResolvedValue([]);

    const result = await listTrainers();

    expect(prisma.trainer.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          deletedAt: null,
          user: { deletedAt: null },
        },
      }),
    );
    expect(result).toEqual([]);
  });

  it('maps trainer rows to public profile shape', async () => {
    prisma.trainer.findMany.mockResolvedValue([
      {
        id: 'trainer-1',
        serviceMode: 'online',
        createdAt: new Date('2024-01-01'),
        user: {
          firstName: 'Jane',
          lastName: 'Doe',
          avatarUrl: 's3://jane-avatar',
          address: { city: 'São Paulo', state: 'SP', country: 'Brazil' },
          socials: { instagram: '@jane', whatsapp: '+55119' },
        },
      },
    ]);
    s3BucketHandler.resolveUrl.mockResolvedValue('https://cdn.example.com/jane.jpg');

    const result = await listTrainers();

    expect(result).toEqual([
      {
        id: 'trainer-1',
        firstName: 'Jane',
        lastName: 'Doe',
        avatarUrl: 'https://cdn.example.com/jane.jpg',
        serviceMode: 'online',
        address: { city: 'São Paulo', state: 'SP', country: 'Brazil' },
        socialNetworks: { instagram: '@jane', whatsapp: '+55119' },
      },
    ]);
    expect(s3BucketHandler.resolveUrl).toHaveBeenCalledWith('s3://jane-avatar');
  });

  it('resolves avatar URLs for all trainers via s3BucketHandler', async () => {
    prisma.trainer.findMany.mockResolvedValue([
      {
        id: 't1',
        serviceMode: null,
        user: { firstName: 'A', lastName: 'B', avatarUrl: 's3://a', address: null, socials: null },
      },
      {
        id: 't2',
        serviceMode: 'in_person',
        user: { firstName: 'C', lastName: 'D', avatarUrl: 's3://c', address: null, socials: null },
      },
    ]);
    s3BucketHandler.resolveUrl
      .mockResolvedValueOnce('https://cdn.example.com/a.jpg')
      .mockResolvedValueOnce('https://cdn.example.com/c.jpg');

    const result = await listTrainers();

    expect(s3BucketHandler.resolveUrl).toHaveBeenCalledTimes(2);
    expect(result[0].avatarUrl).toBe('https://cdn.example.com/a.jpg');
    expect(result[1].avatarUrl).toBe('https://cdn.example.com/c.jpg');
  });

  it('returns null for address and socialNetworks when trainer user has none', async () => {
    prisma.trainer.findMany.mockResolvedValue([
      {
        id: 'trainer-no-extras',
        serviceMode: null,
        user: { firstName: 'Solo', lastName: 'Trainer', avatarUrl: null, address: null, socials: null },
      },
    ]);

    const result = await listTrainers();

    expect(result[0].address).toBeNull();
    expect(result[0].socialNetworks).toBeNull();
    expect(result[0].serviceMode).toBeNull();
  });

  it('queries with correct filters and ordering', async () => {
    prisma.trainer.findMany.mockResolvedValue([]);

    await listTrainers();

    expect(prisma.trainer.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { deletedAt: null, user: { deletedAt: null } },
        orderBy: { createdAt: 'asc' },
      }),
    );
  });
});

describe('listStudents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    s3BucketHandler.resolveUrl.mockResolvedValue(null);
    // Default the adherence + blocker-support queries to empty so tests not
    // focused on those areas don't need to wire them up explicitly. Note
    // trainingProtocol.findMany is called twice inside listStudents (adherence
    // window, then the active-protocol blocker check) — a single
    // mockResolvedValue applies to both calls unless a test overrides with
    // mockResolvedValueOnce chaining (call order: adherence first, then the
    // active-protocol check).
    prisma.trainingProtocol.findMany.mockResolvedValue([]);
    prisma.workoutSession.groupBy.mockResolvedValue([]);
    prisma.studentSubscription.findMany.mockResolvedValue([]);
    prisma.subscriptionPayment.findMany.mockResolvedValue([]);
  });

  it('returns an empty array when the trainer has no linked students', async () => {
    prisma.trainerStudent.findMany.mockResolvedValue([]);

    const result = await listStudents({ trainerId: 'trainer1' });

    expect(prisma.trainerStudent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { trainerId: 'trainer1' } }),
    );
    expect(result).toEqual([]);
  });

  it('returns mapped student profiles with resolved avatar URLs and denormalized fields', async () => {
    const prAt = new Date('2026-05-01T10:00:00Z');
    const lastWorkout = new Date('2026-05-14T18:00:00Z');
    prisma.trainerStudent.findMany.mockResolvedValue([
      {
        studentId: 's1',
        activeOnPlan: true,
        lastWorkoutAt: lastWorkout,
        currentPrLoad: 120,
        currentPrAt: prAt,
        student: { id: 's1', email: 'alice@example.com', firstName: 'Alice', lastName: 'A', avatarUrl: 's3://alice' },
      },
      {
        studentId: 's2',
        activeOnPlan: true,
        lastWorkoutAt: null,
        currentPrLoad: null,
        currentPrAt: null,
        student: { id: 's2', email: 'bob@example.com', firstName: 'Bob', lastName: 'B', avatarUrl: null },
      },
    ]);
    s3BucketHandler.resolveUrl
      .mockResolvedValueOnce('https://cdn.example.com/alice.jpg')
      .mockResolvedValueOnce(null);

    const result = await listStudents({ trainerId: 'trainer1' });

    // No active protocols mocked → adherence fields are null; adherenceMonth is always set.
    const now = new Date();
    const expectedAdherenceMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;

    // Neither student has an active protocol or a subscription mocked, so both
    // pick up the same two blockers (activeOnPlan: true rules out blocked_on_plan).
    const expectedBlockers = [StudentBlocker.NO_ACTIVE_PROTOCOL, StudentBlocker.NO_SUBSCRIPTION];

    expect(result).toEqual([
      {
        id: 's1',
        email: 'alice@example.com',
        firstName: 'Alice',
        lastName: 'A',
        avatarUrl: 'https://cdn.example.com/alice.jpg',
        adherence: null,
        adherenceCompleted: null,
        adherenceExpected: null,
        adherenceMonth: expectedAdherenceMonth,
        lastWorkoutAt: lastWorkout,
        currentPrLoad: 120,
        currentPrAt: prAt,
        ready: false,
        blockers: expectedBlockers,
      },
      {
        id: 's2',
        email: 'bob@example.com',
        firstName: 'Bob',
        lastName: 'B',
        avatarUrl: null,
        adherence: null,
        adherenceCompleted: null,
        adherenceExpected: null,
        adherenceMonth: expectedAdherenceMonth,
        lastWorkoutAt: null,
        currentPrLoad: null,
        currentPrAt: null,
        ready: false,
        blockers: expectedBlockers,
      },
    ]);
  });

  it('computes adherence per student from batched protocol + groupBy queries', async () => {
    // Fake time so weekday occurrences are predictable.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.UTC(2026, 4, 15, 12, 0, 0))); // May 15 noon

    prisma.trainerStudent.findMany.mockResolvedValue([
      {
        studentId: 's1',
        lastWorkoutAt: null,
        currentPrLoad: null,
        currentPrAt: null,
        student: { id: 's1', email: 'a@x.com', firstName: 'A', lastName: 'A', avatarUrl: null },
      },
    ]);
    // Protocol active all month, training every weekday → expected = 15.
    prisma.trainingProtocol.findMany.mockResolvedValue([
      {
        assigneeId: 's1',
        startDate: new Date(Date.UTC(2026, 0, 1)),
        expirationDate: null,
        trainings: [
          { weekDay: 'monday' }, { weekDay: 'tuesday' }, { weekDay: 'wednesday' },
          { weekDay: 'thursday' }, { weekDay: 'friday' }, { weekDay: 'saturday' }, { weekDay: 'sunday' },
        ],
      },
    ]);
    // 12 completed out of 15 expected → 80%.
    prisma.workoutSession.groupBy.mockResolvedValue([{ userId: 's1', _count: { _all: 12 } }]);
    s3BucketHandler.resolveUrl.mockResolvedValue(null);

    const result = await listStudents({ trainerId: 'trainer1' });

    expect(result[0].adherence).toBe(80);
    expect(result[0].adherenceCompleted).toBe(12);
    expect(result[0].adherenceExpected).toBe(15);
    expect(result[0].adherenceMonth).toBe('2026-05-01');
    vi.useRealTimers();
  });

  it('does not flag no_active_protocol for a protocol that has not started yet', async () => {
    prisma.trainerStudent.findMany.mockResolvedValue([
      {
        studentId: 's1',
        activeOnPlan: true,
        lastWorkoutAt: null,
        currentPrLoad: null,
        currentPrAt: null,
        student: { id: 's1', email: 'a@x.com', firstName: 'A', lastName: 'A', avatarUrl: null },
      },
    ]);
    // `trainingProtocol.findMany` is called twice with different `where`
    // shapes. Branch on the presence of `where.startDate` (only the adherence
    // query has it) instead of relying on mock call ORDER — a call-order mock
    // (mockResolvedValueOnce chaining) would pass even if both queries were
    // accidentally given the same `where`, since it doesn't inspect arguments
    // at all. This is defense-in-depth only; the E2E test in
    // trainer-student.e2e.test.js ("does not flag no_active_protocol for a
    // protocol starting in the future") is what actually proves this against
    // a real `where` clause hitting Postgres.
    prisma.trainingProtocol.findMany.mockImplementation(({ where }) => {
      if (where.startDate) {
        // Adherence query excludes the not-yet-started protocol.
        return Promise.resolve([]);
      }
      // Active-protocol blocker check has no startDate filter, so the same
      // protocol counts there.
      return Promise.resolve([{ assigneeId: 's1' }]);
    });
    prisma.studentSubscription.findMany.mockResolvedValue([
      { id: 'sub1', studentId: 's1', status: SubscriptionStatus.ACTIVE },
    ]);

    const result = await listStudents({ trainerId: 'trainer1' });

    expect(result[0].ready).toBe(true);
    expect(result[0].blockers).toEqual([]);
  });

  it('skips the subscriptionPayment query when the roster has no active subscriptions', async () => {
    prisma.trainerStudent.findMany.mockResolvedValue([
      {
        studentId: 's1',
        activeOnPlan: true,
        lastWorkoutAt: null,
        currentPrLoad: null,
        currentPrAt: null,
        student: { id: 's1', email: 'a@x.com', firstName: 'A', lastName: 'A', avatarUrl: null },
      },
    ]);
    prisma.studentSubscription.findMany.mockResolvedValue([
      { id: 'sub1', studentId: 's1', status: SubscriptionStatus.CANCELLED },
    ]);

    await listStudents({ trainerId: 'trainer1' });

    expect(prisma.subscriptionPayment.findMany).not.toHaveBeenCalled();
  });

  it('orders multiple simultaneous blockers per the StudentBlocker enum declaration order', async () => {
    prisma.trainerStudent.findMany.mockResolvedValue([
      {
        studentId: 's1',
        activeOnPlan: false,
        lastWorkoutAt: null,
        currentPrLoad: null,
        currentPrAt: null,
        student: { id: 's1', email: 'a@x.com', firstName: 'A', lastName: 'A', avatarUrl: null },
      },
    ]);
    // No active protocol mocked, no subscription mocked, activeOnPlan: false
    // → all three blocker sources fire simultaneously.

    const result = await listStudents({ trainerId: 'trainer1' });

    expect(result[0].ready).toBe(false);
    expect(result[0].blockers).toEqual([
      StudentBlocker.NO_ACTIVE_PROTOCOL,
      StudentBlocker.NO_SUBSCRIPTION,
      StudentBlocker.BLOCKED_ON_PLAN,
    ]);
  });

  it('flags blocked_on_plan when activeOnPlan is false even though the student is otherwise fully ready', async () => {
    prisma.trainerStudent.findMany.mockResolvedValue([
      {
        studentId: 's1',
        activeOnPlan: false,
        lastWorkoutAt: null,
        currentPrLoad: null,
        currentPrAt: null,
        student: { id: 's1', email: 'a@x.com', firstName: 'A', lastName: 'A', avatarUrl: null },
      },
    ]);
    // Branch on `where.startDate` presence rather than call order — see the
    // comment in the "not started yet" test above for why.
    prisma.trainingProtocol.findMany.mockImplementation(({ where }) => (
      where.startDate ? Promise.resolve([]) : Promise.resolve([{ assigneeId: 's1' }])
    ));
    prisma.studentSubscription.findMany.mockResolvedValue([
      { id: 'sub1', studentId: 's1', status: SubscriptionStatus.ACTIVE },
    ]);

    const result = await listStudents({ trainerId: 'trainer1' });

    expect(result[0].ready).toBe(false);
    expect(result[0].blockers).toEqual([StudentBlocker.BLOCKED_ON_PLAN]);
  });
});

describe('computeStudentBlockers', () => {
  // A baseline set of params representing a fully "ready" student — each test
  // overrides exactly the field(s) relevant to the scenario under test.
  const readyParams = {
    hasActiveProtocol: true,
    subscriptions: [{ id: 'sub1', status: SubscriptionStatus.ACTIVE }],
    overdueSubscriptionIds: new Set(),
    activeOnPlan: true,
  };

  it('returns an empty array when nothing is wrong', () => {
    expect(computeStudentBlockers(readyParams)).toEqual([]);
  });

  it('flags no_active_protocol in isolation when hasActiveProtocol is false', () => {
    const result = computeStudentBlockers({ ...readyParams, hasActiveProtocol: false });
    expect(result).toEqual([StudentBlocker.NO_ACTIVE_PROTOCOL]);
  });

  it('flags no_subscription in isolation when the student has no subscription history', () => {
    const result = computeStudentBlockers({ ...readyParams, subscriptions: [] });
    expect(result).toEqual([StudentBlocker.NO_SUBSCRIPTION]);
  });

  it('flags subscription_cancelled in isolation when no subscription is currently active', () => {
    const result = computeStudentBlockers({
      ...readyParams,
      subscriptions: [{ id: 'sub1', status: SubscriptionStatus.CANCELLED }],
    });
    expect(result).toEqual([StudentBlocker.SUBSCRIPTION_CANCELLED]);
  });

  it('flags subscription_overdue in isolation when the active subscription has an overdue payment', () => {
    const result = computeStudentBlockers({
      ...readyParams,
      overdueSubscriptionIds: new Set(['sub1']),
    });
    expect(result).toEqual([StudentBlocker.SUBSCRIPTION_OVERDUE]);
  });

  it('flags blocked_on_plan in isolation when activeOnPlan is false', () => {
    const result = computeStudentBlockers({ ...readyParams, activeOnPlan: false });
    expect(result).toEqual([StudentBlocker.BLOCKED_ON_PLAN]);
  });

  it('orders multiple simultaneous blockers per the StudentBlocker enum declaration order', () => {
    const result = computeStudentBlockers({
      hasActiveProtocol: false,
      subscriptions: [],
      overdueSubscriptionIds: new Set(),
      activeOnPlan: false,
    });
    expect(result).toEqual([
      StudentBlocker.NO_ACTIVE_PROTOCOL,
      StudentBlocker.NO_SUBSCRIPTION,
      StudentBlocker.BLOCKED_ON_PLAN,
    ]);
  });

  it('does not flag a subscription blocker when an old cancelled subscription coexists with a healthy active one', () => {
    const result = computeStudentBlockers({
      ...readyParams,
      subscriptions: [
        { id: 'old-sub', status: SubscriptionStatus.CANCELLED },
        { id: 'sub1', status: SubscriptionStatus.ACTIVE },
      ],
    });
    expect(result).toEqual([]);
  });

  it('flags subscription_cancelled when the student has subscription history but none is currently active', () => {
    const result = computeStudentBlockers({
      ...readyParams,
      subscriptions: [
        { id: 'old-sub-1', status: SubscriptionStatus.CANCELLED },
        { id: 'old-sub-2', status: SubscriptionStatus.CANCELLED },
      ],
    });
    expect(result).toEqual([StudentBlocker.SUBSCRIPTION_CANCELLED]);
  });

  it('flags subscription_overdue for the active subscription while ignoring an unrelated past cancelled one', () => {
    const result = computeStudentBlockers({
      hasActiveProtocol: true,
      subscriptions: [
        { id: 'old-sub', status: SubscriptionStatus.CANCELLED },
        { id: 'sub1', status: SubscriptionStatus.ACTIVE },
      ],
      overdueSubscriptionIds: new Set(['sub1']),
      activeOnPlan: true,
    });
    expect(result).toEqual([StudentBlocker.SUBSCRIPTION_OVERDUE]);
  });
});

describe('searchStudents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    s3BucketHandler.resolveUrl.mockResolvedValue(null);
  });

  it('returns an empty array when no student matches', async () => {
    prisma.$queryRaw.mockResolvedValue([]);

    const result = await searchStudents({
      trainerId: 'trainer1',
      query: 'nomatch',
      limit: 10,
    });

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(result).toEqual([]);
  });

  it('maps database rows and resolves avatar urls', async () => {
    prisma.$queryRaw.mockResolvedValue([
      {
        id: 's1',
        email: 'alice@example.com',
        firstName: 'Alice',
        lastName: 'Silva',
        avatarUrl: 's3://alice',
      },
      {
        id: 's2',
        email: 'bruno@example.com',
        firstName: 'Bruno',
        lastName: 'Costa',
        avatarUrl: null,
      },
    ]);
    s3BucketHandler.resolveUrl
      .mockResolvedValueOnce('https://cdn.example.com/alice.jpg')
      .mockResolvedValueOnce(null);

    const result = await searchStudents({
      trainerId: 'trainer1',
      query: 'ali',
      limit: 5,
    });

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(result).toEqual([
      {
        id: 's1',
        email: 'alice@example.com',
        firstName: 'Alice',
        lastName: 'Silva',
        avatarUrl: 'https://cdn.example.com/alice.jpg',
      },
      {
        id: 's2',
        email: 'bruno@example.com',
        firstName: 'Bruno',
        lastName: 'Costa',
        avatarUrl: null,
      },
    ]);
  });

  it('caps result limit to a safe maximum', async () => {
    prisma.$queryRaw.mockResolvedValue([]);

    await searchStudents({
      trainerId: 'trainer1',
      query: 'alice',
      limit: 999,
    });

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });
});

describe('unlinkStudent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws student.notLinked when no link exists between trainer and student', async () => {
    prisma.trainerStudent.findUnique.mockResolvedValue(null);

    await expect(
      unlinkStudent({ trainerId: 'trainer1', studentId: 'student1' }),
    ).rejects.toMatchObject({
      error: 'NOT_FOUND',
      messageCode: 'student.notLinked',
      httpStatus: 404,
    });

    expect(prisma.trainerStudent.delete).not.toHaveBeenCalled();
  });

  it('deletes the link when it exists', async () => {
    prisma.trainerStudent.findUnique.mockResolvedValue({
      id: 'link1',
      trainerId: 'trainer1',
      studentId: 'student1',
    });
    prisma.trainerStudent.delete.mockResolvedValue({});

    await unlinkStudent({ trainerId: 'trainer1', studentId: 'student1' });

    expect(prisma.trainerStudent.delete).toHaveBeenCalledWith({
      where: { trainerId_studentId: { trainerId: 'trainer1', studentId: 'student1' } },
    });
  });
});

describe('getOneByUserId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    s3BucketHandler.resolveUrl.mockResolvedValue(null);
  });

  it('throws VALIDATION_ERROR when userId is falsy', async () => {
    await expect(getOneByUserId('')).rejects.toMatchObject({
      error: 'VALIDATION_ERROR',
      messageCode: 'validation.failed',
      httpStatus: 400,
    });

    expect(prisma.trainer.findUnique).not.toHaveBeenCalled();
  });

  it('throws trainer.notFound when no trainer exists for the given userId', async () => {
    prisma.trainer.findUnique.mockResolvedValue(null);

    await expect(getOneByUserId('user-1')).rejects.toMatchObject({
      error: 'NOT_FOUND',
      messageCode: 'trainer.notFound',
      httpStatus: 404,
    });

    expect(prisma.trainer.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'user-1' } }),
    );
  });

  it('returns the flattened trainer profile shape when trainer is found', async () => {
    const trainerRow = {
      id: 'trainer-1',
      userId: 'user-1',
      professionalDocument: 'CREF-123',
      gymName: 'Iron Gym',
      notes: null,
      serviceMode: 'online',
      createdAt: new Date('2024-01-01T00:00:00.000Z'),
      updatedAt: new Date('2024-06-01T00:00:00.000Z'),
      deletedAt: null,
      user: {
        firstName: 'Ana',
        lastName: 'Lima',
        birthDate: new Date('1990-12-18T00:00:00.000Z'),
        avatarUrl: 's3://trainer-avatar',
        address: { id: 'addr-1', city: 'São Paulo', country: 'Brazil' },
        socials: { id: 'soc-1', instagram: '@ana' },
      },
    };

    prisma.trainer.findUnique.mockResolvedValue(trainerRow);
    s3BucketHandler.resolveUrl.mockResolvedValue('https://cdn.example.com/avatar.jpg');

    const result = await getOneByUserId('user-1');

    expect(prisma.trainer.findUnique).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      include: {
        user: {
          include: {
            address: true,
            socials: true,
          },
        },
      },
    });

    expect(s3BucketHandler.resolveUrl).toHaveBeenCalledWith('s3://trainer-avatar');

    expect(result).toMatchObject({
      id: 'trainer-1',
      firstName: 'Ana',
      lastName: 'Lima',
      avatarUrl: 'https://cdn.example.com/avatar.jpg',
      professionalDocument: 'CREF-123',
      gymName: 'Iron Gym',
      serviceMode: 'online',
      address: { id: 'addr-1', city: 'São Paulo', country: 'Brazil' },
      socialNetworks: { id: 'soc-1', instagram: '@ana' },
    });

    // userId must not be present in the response
    expect(result).not.toHaveProperty('userId');
    // user sub-object must not be present (it is flattened)
    expect(result).not.toHaveProperty('user');
  });

  it('formats birthDate as YYYY-MM-DD string', async () => {
    prisma.trainer.findUnique.mockResolvedValue({
      id: 'trainer-1',
      userId: 'user-1',
      user: {
        firstName: 'Ana',
        lastName: 'Lima',
        birthDate: new Date('1990-12-18T03:00:00.000Z'),
        avatarUrl: null,
        address: null,
        socials: null,
      },
    });

    const result = await getOneByUserId('user-1');

    expect(result.birthDate).toBe('1990-12-18');
  });

  it('returns null for birthDate when the user has no birthDate set', async () => {
    prisma.trainer.findUnique.mockResolvedValue({
      id: 'trainer-1',
      userId: 'user-1',
      user: {
        firstName: 'Bob',
        lastName: 'Smith',
        birthDate: null,
        avatarUrl: null,
        address: null,
        socials: null,
      },
    });

    const result = await getOneByUserId('user-1');

    expect(result.birthDate).toBeNull();
  });

  it('returns null for address and socialNetworks when the user has neither', async () => {
    prisma.trainer.findUnique.mockResolvedValue({
      id: 'trainer-1',
      userId: 'user-1',
      user: {
        firstName: 'Solo',
        lastName: 'Trainer',
        birthDate: null,
        avatarUrl: null,
        address: null,
        socials: null,
      },
    });

    const result = await getOneByUserId('user-1');

    expect(result.address).toBeNull();
    expect(result.socialNetworks).toBeNull();
  });
});
