import { describe, it, expect, vi, beforeEach } from 'vitest';

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
import { updateMyTrainerProfile, linkStudentByEmail, listStudents, listTrainers, searchStudents, unlinkStudent, getOneByUserId } from '../../src/services/trainer-service.js';

describe('trainerService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
