import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';

vi.mock('../../src/services/platform-plan-service.js', () => ({
  assertStudentActiveOnPlan: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/services/trainer-onboarding-service.js', () => ({
  maybeMarkFirstProtocolCreated: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/db.js', () => ({
  prisma: {
    trainer: { findUnique: vi.fn() },
    user: { findUnique: vi.fn() },
    trainingTemplate: { findMany: vi.fn() },
    exerciseTemplate: { findMany: vi.fn() },
    advancedTechnique: { findMany: vi.fn() },
    trainingProtocol: { create: vi.fn() },
    $transaction: vi.fn(),
  },
}));

import { prisma } from '../../src/db.js';
import { createProtocolWithTrainings } from '../../src/services/training-protocol-service.js';
import { SupersetConstraints, SupersetMessageCode } from '../../src/constants/training.js';

const ASSIGNEE_ID = 'user-assignee-1';

// Builds a minimal bulk exercise body.
const exercise = (name, order, extra = {}) => ({ name, type: 'strength', order, sets: 3, ...extra });

// Builds N contiguous members sharing one client group id.
const groupMembers = (count, groupId = randomUUID()) =>
  Array.from({ length: count }, (_, i) => exercise(`G${i}`, i, { supersetGroupId: groupId, supersetOrder: i }));

// Wraps exercises into a one-training bulk protocol payload.
const payloadWith = (exercises) => ({
  assigneeId: ASSIGNEE_ID,
  name: 'Protocol',
  startDate: '2026-01-01',
  trainings: [{ name: 'A', category: 'strength', order: 0, exercises }],
});

describe('createProtocolWithTrainings — superset group validation', () => {
  beforeEach(() => {
    prisma.trainer.findUnique.mockResolvedValue({ id: 'trainer-1' });
    prisma.user.findUnique.mockResolvedValue({ id: ASSIGNEE_ID, deletedAt: null });
    prisma.trainingTemplate.findMany.mockResolvedValue([]);
    prisma.exerciseTemplate.findMany.mockResolvedValue([]);
    prisma.advancedTechnique.findMany.mockResolvedValue([]);
    prisma.trainingProtocol.create.mockResolvedValue({ id: 'p1', assignee: {}, trainings: [] });
    prisma.$transaction.mockImplementation(async (fn) => fn(prisma));
  });

  async function expectRejected(exercises, messageCode) {
    await expect(createProtocolWithTrainings('u1', payloadWith(exercises))).rejects.toMatchObject({
      httpStatus: 400,
      error: 'VALIDATION_ERROR',
      messageCode,
    });
    expect(prisma.trainingProtocol.create).not.toHaveBeenCalled();
  }

  it('rejects a group with a single member with supersetMinMembers', async () => {
    await expectRejected(groupMembers(1), SupersetMessageCode.MIN_MEMBERS);
  });

  it('rejects a group above the maximum size with supersetMaxMembers', async () => {
    await expectRejected(groupMembers(SupersetConstraints.MAX_MEMBERS + 1), SupersetMessageCode.MAX_MEMBERS);
  });

  it('rejects non-contiguous group members with supersetMembershipInvalid', async () => {
    const groupId = randomUUID();
    const exercises = [
      exercise('A', 0, { supersetGroupId: groupId, supersetOrder: 0 }),
      exercise('Between', 1),
      exercise('B', 2, { supersetGroupId: groupId, supersetOrder: 1 }),
    ];

    await expectRejected(exercises, SupersetMessageCode.MEMBERSHIP_INVALID);
  });

  it('rejects a substitute that carries a supersetGroupId with supersetMembershipInvalid', async () => {
    const exercises = [exercise('A', 0, { substitutes: [{ name: 'Alt', type: 'strength', supersetGroupId: randomUUID() }] })];

    await expectRejected(exercises, SupersetMessageCode.MEMBERSHIP_INVALID);
  });

  it('validates each training independently (same client group id in two trainings is two groups)', async () => {
    const sharedId = randomUUID();
    const payload = {
      ...payloadWith(groupMembers(2, sharedId)),
      trainings: [
        { name: 'A', category: 'strength', order: 0, exercises: groupMembers(2, sharedId) },
        { name: 'B', category: 'strength', order: 1, exercises: groupMembers(2, sharedId) },
      ],
    };

    await createProtocolWithTrainings('u1', payload);

    expect(prisma.trainingProtocol.create).toHaveBeenCalledOnce();
  });

  it('does not touch the database creation for valid old payloads without superset fields', async () => {
    await createProtocolWithTrainings('u1', payloadWith([exercise('A', 0), exercise('B', 1)]));

    expect(prisma.trainingProtocol.create).toHaveBeenCalledOnce();
  });
});
