import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/db.js', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    trainerStudent: { findFirst: vi.fn() },
    trainerInvite: { findFirst: vi.fn() },
    account: { findFirst: vi.fn() },
  },
}));

vi.mock('../../src/services/address-service.js', () => ({ getAddressByPostalCode: vi.fn() }));
vi.mock('../../src/services/platform-plan-service.js', () => ({ buildPlatformPlanForMe: vi.fn() }));

import { prisma } from '../../src/db.js';
import config from '../../config/index.js';
import { getUserProfileById } from '../../src/services/user-service.js';
import { Roles } from '../../src/constants/roles.js';
import { UserStatus } from '../../src/constants/user-status.js';

const USER_ID = 'user-1';
const SIGNUP_SOURCE_WEB_DIRECT = 'web_direct';

// Builds the user row GET /me reads, as stored for a direct web signup.
function makeUserRow(overrides = {}) {
  return {
    id: USER_ID,
    email: 'plain@example.com',
    roles: [],
    status: UserStatus.ACTIVE,
    firstName: 'Bia',
    lastName: 'Souza',
    gender: null,
    birthDate: null,
    avatarUrl: null,
    signupSource: SIGNUP_SOURCE_WEB_DIRECT,
    trainer: null,
    ...overrides,
  };
}

describe('getUserProfileById (GET /me) after the invite gate removal', () => {
  const originalGateEnabled = config.betaInviteGate.enabled;

  beforeEach(() => {
    prisma.user.findUnique.mockResolvedValue(makeUserRow());
    prisma.trainerStudent.findFirst.mockResolvedValue(null);
    prisma.trainerInvite.findFirst.mockResolvedValue(null);
    prisma.account.findFirst.mockResolvedValue(null);
  });

  afterEach(() => {
    config.betaInviteGate.enabled = originalGateEnabled;
  });

  describe.each([
    ['enabled', true],
    ['disabled', false],
  ])('with the beta invite gate flag %s', (_label, gateEnabled) => {
    beforeEach(() => {
      config.betaInviteGate.enabled = gateEnabled;
    });

    it('should report betaAccess true for a user with no role and no invite', async () => {
      const profile = await getUserProfileById(USER_ID);

      expect(profile.betaAccess).toBe(true);
    });

    it('should report betaAccess true for a nutritionist with no invite', async () => {
      prisma.user.findUnique.mockResolvedValue(makeUserRow({ roles: [Roles.NUTRITIONIST] }));

      const profile = await getUserProfileById(USER_ID);

      expect(profile.betaAccess).toBe(true);
    });
  });

  it('should keep reporting emailVerified false while no account is verified', async () => {
    const profile = await getUserProfileById(USER_ID);

    expect(profile.emailVerified).toBe(false);
  });

  it('should not expose signupSource', async () => {
    const profile = await getUserProfileById(USER_ID);

    expect(profile).not.toHaveProperty('signupSource');
  });
});
