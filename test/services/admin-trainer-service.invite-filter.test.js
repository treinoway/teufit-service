import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InviteStatus } from '../../src/constants/trainer-invite.js';

vi.mock('../../src/services/platform-plan-service.js', () => ({
  getTrainerPlan: vi.fn(),
  enforceStudentCapAfterDowngrade: vi.fn(),
  reactivateStudentsUpToCap: vi.fn(),
}));

import { listTrainers } from '../../src/services/admin-trainer-service.js';

const INVITE_FILTER = Object.freeze({ NONE: 'none', PENDING: 'pending', ACCEPTED: 'accepted' });

const mockPrisma = {
  user: { findMany: vi.fn(), count: vi.fn() },
  trainer: { findMany: vi.fn(), count: vi.fn() },
  trainerInvite: { findMany: vi.fn() },
  trainerStudent: { groupBy: vi.fn() },
};

// Returns the serialized where of the user list query.
function userWhereJson() {
  return JSON.stringify(mockPrisma.user.findMany.mock.calls[0][0].where);
}

describe('listTrainers inviteStatus filter with includeSignups', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.user.findMany.mockResolvedValue([]);
    mockPrisma.user.count.mockResolvedValue(0);
    mockPrisma.trainerInvite.findMany.mockResolvedValue([]);
    mockPrisma.trainerStudent.groupBy.mockResolvedValue([]);
  });

  it('should filter accepted by redeemed accepted invites without looking up pending emails', async () => {
    await listTrainers(mockPrisma, { includeSignups: true, inviteStatus: INVITE_FILTER.ACCEPTED });

    expect(userWhereJson()).toContain(`"invitesRedeemed":{"some":{"status":"${InviteStatus.ACCEPTED}"}}`);
    expect(mockPrisma.trainerInvite.findMany).not.toHaveBeenCalled();
  });

  it('should return an empty page with total 0 for pending when no pending invite exists', async () => {
    const result = await listTrainers(mockPrisma, { includeSignups: true, inviteStatus: INVITE_FILTER.PENDING });

    expect(userWhereJson()).toContain('"id":{"in":[]}');
    expect(result).toMatchObject({ items: [], total: 0 });
  });

  it('should combine NOT email match with no accepted redemption for none', async () => {
    mockPrisma.trainerInvite.findMany.mockResolvedValueOnce([{ email: 'p@example.com' }]);

    await listTrainers(mockPrisma, { includeSignups: true, inviteStatus: INVITE_FILTER.NONE });

    const where = userWhereJson();
    expect(where).toContain('"NOT":{"OR":[{"email":{"equals":"p@example.com","mode":"insensitive"}}]}');
    expect(where).toContain(`"invitesRedeemed":{"none":{"status":"${InviteStatus.ACCEPTED}"}}`);
  });

  it('should restrict the signup branch to live users with no trainer profile or memberships', async () => {
    await listTrainers(mockPrisma, { includeSignups: true });

    const where = userWhereJson();
    expect(where).toContain('"trainers":{"none":{}}');
    expect(where).toContain('"trainer":{"is":null}');
    expect(where).toContain('"deletedAt":null');
  });
});
