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
import config from '../../config/index.js';

const USER_ID = 'user-1';

describe('hasBetaAccess', () => {
  // Most tests below exercise the gate-ENABLED exemption/invite-lookup logic
  // (admin/trainer role exemption, tester allowlist, accepted-invite DB
  // lookup). The test environment defaults the kill-switch OFF (see
  // config/environments/test.js — dozens of unrelated e2e fixtures
  // self-promote to trainer and would 403 otherwise), so force it on here
  // and restore afterward so state doesn't leak into other test files. The
  // "beta invite gate kill-switch disabled" describe block below overrides
  // this per-test to cover the short-circuit branch itself.
  // Capture whatever config/environments/test.js sets as the baseline (rather
  // than hardcoding `false`) so this file doesn't silently corrupt state if
  // that default ever changes.
  const originalGateEnabled = config.betaInviteGate.enabled;

  beforeEach(() => {
    vi.clearAllMocks();
    config.betaInviteGate.enabled = true;
  });

  afterEach(() => {
    config.betaInviteGate.enabled = originalGateEnabled;
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

  it('returns true for a plain user with an accepted invite without hitting the DB', async () => {
    prisma.trainerInvite.findFirst.mockResolvedValue({ id: 'invite-1' });

    const result = await hasBetaAccess({ id: USER_ID, email: 'plain@example.com', roles: [] });

    expect(result).toBe(true);
    expect(prisma.trainerInvite.findFirst).not.toHaveBeenCalled();
  });

  it('returns true when no accepted invite exists for the user', async () => {
    prisma.trainerInvite.findFirst.mockResolvedValue(null);

    const result = await hasBetaAccess({ id: USER_ID, email: 'plain@example.com', roles: [] });

    expect(result).toBe(true);
    expect(prisma.trainerInvite.findFirst).not.toHaveBeenCalled();
  });

  it('returns true without hitting the DB when the user has no id', async () => {
    const result = await hasBetaAccess({ email: 'plain@example.com', roles: [] });
    expect(result).toBe(true);
    expect(prisma.trainerInvite.findFirst).not.toHaveBeenCalled();
  });

  it('returns true when the roles array is missing, without an invite lookup', async () => {
    prisma.trainerInvite.findFirst.mockResolvedValue(null);

    const result = await hasBetaAccess({ id: USER_ID, email: 'plain@example.com' });

    expect(result).toBe(true);
    expect(prisma.trainerInvite.findFirst).not.toHaveBeenCalled();
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

    it('returns true for an email that is absent from the allowlist (the allowlist no longer matters)', async () => {
      config.betaInviteGate.testerEmails = ['qa@example.com'];
      prisma.trainerInvite.findFirst.mockResolvedValue(null);

      const result = await hasBetaAccess({ id: USER_ID, email: 'not-a-tester@example.com', roles: [] });

      expect(result).toBe(true);
      expect(prisma.trainerInvite.findFirst).not.toHaveBeenCalled();
    });

    it('returns true when the allowlist is empty (default/unset BETA_TESTER_EMAILS)', async () => {
      config.betaInviteGate.testerEmails = [];
      prisma.trainerInvite.findFirst.mockResolvedValue(null);

      const result = await hasBetaAccess({ id: USER_ID, email: 'plain@example.com', roles: [] });

      expect(result).toBe(true);
      expect(prisma.trainerInvite.findFirst).not.toHaveBeenCalled();
    });
  });

  // config.betaInviteGate.enabled === false is the emergency kill-switch:
  // once !user is ruled out, every authenticated user gets true with zero DB
  // hits, before isTesterAllowlistedEmail/roles/prisma are ever touched.
  describe('beta invite gate kill-switch disabled', () => {
    beforeEach(() => {
      config.betaInviteGate.enabled = false;
    });

    it('returns true for a plain user with roles: [] and a real id, without hitting the DB', async () => {
      const result = await hasBetaAccess({ id: USER_ID, email: 'plain@example.com', roles: [] });

      expect(result).toBe(true);
      expect(prisma.trainerInvite.findFirst).not.toHaveBeenCalled();
    });

    it('returns true even for a user with no id at all', async () => {
      const result = await hasBetaAccess({ email: 'plain@example.com', roles: [] });

      expect(result).toBe(true);
      expect(prisma.trainerInvite.findFirst).not.toHaveBeenCalled();
    });

    it('still returns false when user is falsy, regardless of the gate flag', async () => {
      const result = await hasBetaAccess(null);

      expect(result).toBe(false);
      expect(prisma.trainerInvite.findFirst).not.toHaveBeenCalled();
    });

    it('does not depend on the tester allowlist or roles — a non-admin, non-tester email still gets true', async () => {
      config.betaInviteGate.testerEmails = ['qa@example.com'];

      try {
        const result = await hasBetaAccess({ id: USER_ID, email: 'not-a-tester@example.com', roles: [] });

        expect(result).toBe(true);
        expect(prisma.trainerInvite.findFirst).not.toHaveBeenCalled();
      } finally {
        config.betaInviteGate.testerEmails = [];
      }
    });
  });
});
