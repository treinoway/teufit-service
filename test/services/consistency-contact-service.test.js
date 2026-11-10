import { beforeEach, describe, expect, it, vi } from 'vitest';
import { lastContact, logContact } from '../../src/services/consistency-contact-service.js';
import { Pillar } from '../../src/constants/consistency-ranking.js';

const TRAINER_ID = 'trainer-1';
const STUDENT_ID = 'student-1';
const NOW = new Date('2026-11-11T15:00:00Z');

// Prisma mock with the student link and the contact log
function createPrisma({ linked = true, last = null } = {}) {
  return {
    trainerStudent: { findFirst: vi.fn().mockResolvedValue(linked ? { id: 'link-1' } : null) },
    consistencyContactLog: {
      create: vi.fn(async ({ data }) => ({ id: 'log-1', ...data })),
      findFirst: vi.fn().mockResolvedValue(last),
    },
  };
}

describe('logContact', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('PAN-50 logs trainer, student, pillar and date of each WhatsApp use', async () => {
    const prisma = createPrisma();

    const logged = await logContact(prisma, TRAINER_ID, STUDENT_ID, Pillar.CARDIO, NOW);

    expect(prisma.consistencyContactLog.create).toHaveBeenCalledWith({
      data: { trainerId: TRAINER_ID, studentId: STUDENT_ID, pillar: Pillar.CARDIO, createdAt: NOW },
    });
    expect(logged).toEqual({ studentId: STUDENT_ID, pillar: Pillar.CARDIO, createdAt: NOW });
  });

  it('PAN-50 logs a contact without a pillar as null', async () => {
    const prisma = createPrisma();

    const logged = await logContact(prisma, TRAINER_ID, STUDENT_ID, undefined, NOW);

    expect(prisma.consistencyContactLog.create.mock.calls[0][0].data.pillar).toBeNull();
    expect(logged.pillar).toBeNull();
  });

  it('PAN-50 logs every use, repeating contacts with the same student', async () => {
    const prisma = createPrisma();

    await logContact(prisma, TRAINER_ID, STUDENT_ID, Pillar.WORKOUTS, NOW);
    await logContact(prisma, TRAINER_ID, STUDENT_ID, Pillar.WORKOUTS, NOW);

    expect(prisma.consistencyContactLog.create).toHaveBeenCalledTimes(2);
  });

  it('PAN-51 answers 404 and logs nothing for a student of another trainer', async () => {
    const prisma = createPrisma({ linked: false });

    const error = await logContact(prisma, TRAINER_ID, 'stranger', Pillar.CARDIO, NOW).catch((caught) => caught);

    expect(error).toMatchObject({ httpStatus: 404, messageCode: 'student.notFound' });
    expect(prisma.trainerStudent.findFirst.mock.calls[0][0].where).toEqual({ trainerId: TRAINER_ID, studentId: 'stranger' });
    expect(prisma.consistencyContactLog.create).not.toHaveBeenCalled();
  });
});

describe('lastContact', () => {
  it('PAN-26 returns the date of the most recent contact', async () => {
    const prisma = createPrisma({ last: { createdAt: NOW } });

    expect(await lastContact(prisma, TRAINER_ID, STUDENT_ID)).toEqual(NOW);
    expect(prisma.consistencyContactLog.findFirst).toHaveBeenCalledWith({
      where: { trainerId: TRAINER_ID, studentId: STUDENT_ID },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
  });

  it('PAN-26 returns null when the student was never contacted', async () => {
    expect(await lastContact(createPrisma({ last: null }), TRAINER_ID, STUDENT_ID)).toBeNull();
  });
});
