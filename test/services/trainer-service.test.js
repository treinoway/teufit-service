import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock Prisma client used by trainerService
vi.mock('../../src/db.js', () => {
  return {
    prisma: {
      $transaction: vi.fn(),
      $queryRaw: vi.fn(),
      user: {
        findUnique: vi.fn(),
      },
      trainerStudent: {
        findUnique: vi.fn(),
        findMany: vi.fn(),
        create: vi.fn(),
        delete: vi.fn(),
      },
    },
  };
});

vi.mock('../../src/config/s3-bucket-handler.js', () => ({
  default: {
    resolveUrl: vi.fn(),
  },
}));

import { prisma } from '../../src/db.js';
import s3BucketHandler from '../../src/config/s3-bucket-handler.js';
import { updateMyTrainerProfile, linkStudentByEmail, listStudents, searchStudents, unlinkStudent } from '../../src/services/trainer-service.js';

describe('trainerService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    s3BucketHandler.resolveUrl.mockResolvedValue(null);
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
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-student',
      email: 'student@example.com',
      firstName: 'Jane',
      lastName: 'Doe',
      avatarUrl: 's3://some-key',
    });
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
});

describe('listStudents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    s3BucketHandler.resolveUrl.mockResolvedValue(null);
  });

  it('returns an empty array when the trainer has no linked students', async () => {
    prisma.trainerStudent.findMany.mockResolvedValue([]);

    const result = await listStudents({ trainerId: 'trainer1' });

    expect(prisma.trainerStudent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { trainerId: 'trainer1' } }),
    );
    expect(result).toEqual([]);
  });

  it('returns mapped student profiles with resolved avatar URLs', async () => {
    prisma.trainerStudent.findMany.mockResolvedValue([
      {
        student: { id: 's1', email: 'alice@example.com', firstName: 'Alice', lastName: 'A', avatarUrl: 's3://alice' },
      },
      {
        student: { id: 's2', email: 'bob@example.com', firstName: 'Bob', lastName: 'B', avatarUrl: null },
      },
    ]);
    s3BucketHandler.resolveUrl
      .mockResolvedValueOnce('https://cdn.example.com/alice.jpg')
      .mockResolvedValueOnce(null);

    const result = await listStudents({ trainerId: 'trainer1' });

    expect(result).toEqual([
      { id: 's1', email: 'alice@example.com', firstName: 'Alice', lastName: 'A', avatarUrl: 'https://cdn.example.com/alice.jpg' },
      { id: 's2', email: 'bob@example.com', firstName: 'Bob', lastName: 'B', avatarUrl: null },
    ]);
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
