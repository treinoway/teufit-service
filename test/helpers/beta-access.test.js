import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock Prisma before importing the helper under test.
vi.mock('../../src/db.js', () => {
  return {
    prisma: {
      trainerInvite: {
        findFirst: vi.fn(),
      },
    },
  };
});

import { prisma } from '../../src/db.js';
import { hasBetaAccess } from '../../src/helpers/beta-access.js';
import { InviteStatus } from '../../src/constants/trainer-invite.js';
import config from '../../config/index.js';

const USER_ID = 'user-1';

describe('hasBetaAccess', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns false when user is falsy', async () => {
    const result = await hasBetaAccess(null);
    expect(result).toBe(false);
    expect(prisma.trainerInvite.findFirst).not.toHaveBeenCalled();
  });

  it('returns true for a user with the admin role without hitting the DB', async () => {
    const result = await hasBetaAccess({ id: USER_ID, email: 'plain@example.com', roles: ['admin'] });
    expect(result).toBe(true);
    expect(prisma.trainerInvite.findFirst).not.toHaveBeenCalled();
  });

  it('returns true for a user with the trainer role without hitting the DB', async () => {
    const result = await hasBetaAccess({ id: USER_ID, email: 'plain@example.com', roles: ['trainer'] });
    expect(result).toBe(true);
    expect(prisma.trainerInvite.findFirst).not.toHaveBeenCalled();
  });

  it('queries for an accepted invite for a plain user with no exempt role', async () => {
    prisma.trainerInvite.findFirst.mockResolvedValue({ id: 'invite-1' });

    const result = await hasBetaAccess({ id: USER_ID, email: 'plain@example.com', roles: [] });

    expect(result).toBe(true);
    expect(prisma.trainerInvite.findFirst).toHaveBeenCalledWith({
      where: { userId: USER_ID, status: InviteStatus.ACCEPTED },
      select: { id: true },
    });
  });

  it('returns false when no accepted invite exists for the user', async () => {
    prisma.trainerInvite.findFirst.mockResolvedValue(null);

    const result = await hasBetaAccess({ id: USER_ID, email: 'plain@example.com', roles: [] });

    expect(result).toBe(false);
  });

  it('returns false without hitting the DB when the user has no id', async () => {
    const result = await hasBetaAccess({ email: 'plain@example.com', roles: [] });
    expect(result).toBe(false);
    expect(prisma.trainerInvite.findFirst).not.toHaveBeenCalled();
  });

  it('treats a missing roles array as empty (falls through to invite lookup)', async () => {
    prisma.trainerInvite.findFirst.mockResolvedValue(null);

    const result = await hasBetaAccess({ id: USER_ID, email: 'plain@example.com' });

    expect(result).toBe(false);
    expect(prisma.trainerInvite.findFirst).toHaveBeenCalled();
  });

  describe('tester email allowlist (BETA_TESTER_EMAILS)', () => {
    afterEach(() => {
      // Restore to the config default so no state leaks into other test files.
      config.betaInviteGate.testerEmails = [];
    });

    it('returns true for a tester-allowlisted email without hitting the DB', async () => {
      config.betaInviteGate.testerEmails = ['qa@example.com'];

      const result = await hasBetaAccess({ id: USER_ID, email: 'qa@example.com', roles: [] });

      expect(result).toBe(true);
      expect(prisma.trainerInvite.findFirst).not.toHaveBeenCalled();
    });

    it('matches a tester-allowlisted email case-insensitively without hitting the DB', async () => {
      config.betaInviteGate.testerEmails = ['qa@example.com'];

      const result = await hasBetaAccess({ id: USER_ID, email: '  QA@Example.com  ', roles: [] });

      expect(result).toBe(true);
      expect(prisma.trainerInvite.findFirst).not.toHaveBeenCalled();
    });

    it('does not exempt an email that is absent from the allowlist (falls through to invite lookup)', async () => {
      config.betaInviteGate.testerEmails = ['qa@example.com'];
      prisma.trainerInvite.findFirst.mockResolvedValue(null);

      const result = await hasBetaAccess({ id: USER_ID, email: 'not-a-tester@example.com', roles: [] });

      expect(result).toBe(false);
      expect(prisma.trainerInvite.findFirst).toHaveBeenCalledWith({
        where: { userId: USER_ID, status: InviteStatus.ACCEPTED },
        select: { id: true },
      });
    });

    it('exempts no one when the allowlist is empty (default/unset BETA_TESTER_EMAILS)', async () => {
      config.betaInviteGate.testerEmails = [];
      prisma.trainerInvite.findFirst.mockResolvedValue(null);

      const result = await hasBetaAccess({ id: USER_ID, email: 'plain@example.com', roles: [] });

      expect(result).toBe(false);
      expect(prisma.trainerInvite.findFirst).toHaveBeenCalled();
    });
  });
});
