import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/services/platform-plan-service.js', () => ({
  getTrainerPlan: vi.fn(),
  enforceStudentCapAfterDowngrade: vi.fn(),
  reactivateStudentsUpToCap: vi.fn(),
}));

import { escapeLikePattern, listTrainers } from '../../src/services/admin-trainer-service.js';

const mockPrisma = {
  user: { findMany: vi.fn(), count: vi.fn() },
  trainer: { findMany: vi.fn(), count: vi.fn() },
  trainerInvite: { findMany: vi.fn() },
  trainerStudent: { groupBy: vi.fn() },
};

describe('escapeLikePattern', () => {
  it('should escape backslash, percent and underscore', () => {
    expect(escapeLikePattern('a_b%c\\d')).toBe('a\\_b\\%c\\\\d');
  });

  it('should leave plain emails untouched', () => {
    expect(escapeLikePattern('ana@example.com')).toBe('ana@example.com');
  });
});

describe('listTrainers pending filter email escaping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.user.findMany.mockResolvedValue([]);
    mockPrisma.user.count.mockResolvedValue(0);
    mockPrisma.trainerStudent.groupBy.mockResolvedValue([]);
  });

  it('should pass escaped emails to the insensitive equals filter', async () => {
    mockPrisma.trainerInvite.findMany.mockResolvedValueOnce([{ email: 'in_v%@example.com' }]);

    await listTrainers(mockPrisma, { includeSignups: true, inviteStatus: 'pending' });

    const equals = mockPrisma.user.findMany.mock.calls[0][0].where.AND.at(-1).AND[1].OR[0].email;
    expect(equals).toEqual({ equals: 'in\\_v\\%@example.com', mode: 'insensitive' });
  });
});
