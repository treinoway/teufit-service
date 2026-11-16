import { beforeEach, describe, expect, it, vi } from 'vitest';
import { joinAllModeChallenges } from '../../src/services/challenge-participant-sync.js';

const TRAINER_ID = 'trainer-1';
const STUDENT_ID = 'new-student';
const NOW = new Date('2026-11-18T15:00:00.000Z');

const prisma = {
  challenge: { findMany: vi.fn() },
  challengeParticipant: { createMany: vi.fn() },
};

// Championship row of the trainer: weekly, all mode, open, unless overridden
function championship(id, overrides = {}) {
  return {
    id,
    trainerId: TRAINER_ID,
    format: 'weeks',
    participantMode: 'all',
    cancelledAt: null,
    closedAt: null,
    ...overrides,
  };
}

const STORED = [
  championship('scheduled-all'),
  championship('active-all'),
  championship('dates-all', { format: 'dates' }),
  championship('weekly-filter', { participantMode: 'filter' }),
  championship('weekly-explicit', { participantMode: 'explicit' }),
  championship('closed-all', { closedAt: new Date('2026-11-16T00:10:00.000Z') }),
  championship('cancelled-all', { cancelledAt: new Date('2026-11-17T10:00:00.000Z') }),
  championship('other-trainer', { trainerId: 'trainer-2' }),
];

// Whether a row satisfies an equality-only Prisma where clause
function matches(row, where) {
  return Object.entries(where).every(([field, value]) => {
    if (value && typeof value === 'object' && 'in' in value) return value.in.includes(row[field]);
    return row[field] === value;
  });
}

beforeEach(() => {
  prisma.challenge.findMany.mockImplementation(async ({ where }) => STORED.filter((row) => matches(row, where)));
  prisma.challengeParticipant.createMany.mockImplementation(async ({ data }) => ({ count: data.length }));
});

describe('joinAllModeChallenges', () => {
  it('CAMP-13 adds a newly linked student to scheduled and active all-mode weekly championships', async () => {
    const added = await joinAllModeChallenges(prisma, TRAINER_ID, STUDENT_ID, NOW);

    expect(added).toBe(2);
    expect(prisma.challengeParticipant.createMany).toHaveBeenCalledWith({
      data: [
        { challengeId: 'scheduled-all', studentId: STUDENT_ID, createdAt: NOW },
        { challengeId: 'active-all', studentId: STUDENT_ID, createdAt: NOW },
      ],
      skipDuplicates: true,
    });
  });

  it('CAMP-13 leaves out dates, filter, chosen, closed and cancelled championships', async () => {
    await joinAllModeChallenges(prisma, TRAINER_ID, STUDENT_ID, NOW);

    const joined = prisma.challengeParticipant.createMany.mock.calls[0][0].data.map((row) => row.challengeId);
    expect(joined).not.toEqual(expect.arrayContaining(['dates-all']));
    expect(joined).not.toEqual(expect.arrayContaining(['weekly-filter']));
    expect(joined).not.toEqual(expect.arrayContaining(['weekly-explicit']));
    expect(joined).not.toEqual(expect.arrayContaining(['closed-all']));
    expect(joined).not.toEqual(expect.arrayContaining(['cancelled-all']));
    expect(joined).not.toEqual(expect.arrayContaining(['other-trainer']));
  });

  it('CAMP-13 adds nothing when the trainer has no open all-mode weekly championship', async () => {
    const added = await joinAllModeChallenges(prisma, 'trainer-without-championships', STUDENT_ID, NOW);

    expect(added).toBe(0);
    expect(prisma.challengeParticipant.createMany).not.toHaveBeenCalled();
  });

  it('CAMP-13 keeps one row per championship and student when the student is already in', async () => {
    prisma.challengeParticipant.createMany.mockResolvedValue({ count: 1 });

    const added = await joinAllModeChallenges(prisma, TRAINER_ID, STUDENT_ID, NOW);

    expect(added).toBe(1);
    expect(prisma.challengeParticipant.createMany.mock.calls[0][0].skipDuplicates).toBe(true);
  });
});
