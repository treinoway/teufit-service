import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/db.js', () => ({
  prisma: {
    trainerInvite: { findFirst: vi.fn() },
  },
}));

import { prisma } from '../../src/db.js';
import config from '../../config/index.js';
import { hasBetaAccess } from '../../src/helpers/beta-access.js';
import { InviteErrorCode, InviteMessageCode } from '../../src/constants/trainer-invite.js';
import { Roles } from '../../src/constants/roles.js';
import { getMeSchema } from '../../api/schemas/user-route.schema.js';
import ptBR from '../../src/i18n/locales/pt-BR.js';
import enUS from '../../src/i18n/locales/en-US.js';

const USER_ID = 'user-1';
const PLAIN_EMAIL = 'plain@example.com';

describe('beta access after the invite gate removal', () => {
  const originalGateEnabled = config.betaInviteGate.enabled;

  beforeEach(() => {
    prisma.trainerInvite.findFirst.mockResolvedValue(null);
  });

  afterEach(() => {
    config.betaInviteGate.enabled = originalGateEnabled;
  });

  describe.each([
    ['enabled', true],
    ['disabled', false],
  ])('hasBetaAccess with the gate flag %s', (_label, gateEnabled) => {
    beforeEach(() => {
      config.betaInviteGate.enabled = gateEnabled;
    });

    it.each([
      ['a user with no role and no accepted invite', { id: USER_ID, email: PLAIN_EMAIL, roles: [] }],
      ['a nutritionist with no accepted invite', { id: USER_ID, email: PLAIN_EMAIL, roles: [Roles.NUTRITIONIST] }],
      ['a trainer', { id: USER_ID, email: PLAIN_EMAIL, roles: [Roles.TRAINER] }],
      ['a user whose roles are missing', { id: USER_ID, email: PLAIN_EMAIL }],
    ])('should return true for %s', async (_userLabel, user) => {
      await expect(hasBetaAccess(user)).resolves.toBe(true);
    });
  });

  describe('contract kept for old clients', () => {
    it('should keep the INVITE_REQUIRED error code constant', () => {
      expect(InviteErrorCode.INVITE_REQUIRED).toBe('INVITE_REQUIRED');
    });

    it('should keep the invite.required messageCode constant', () => {
      expect(InviteMessageCode.REQUIRED).toBe('invite.required');
    });

    it.each([
      ['pt-BR', ptBR],
      ['en-US', enUS],
    ])('should keep the invite.required translation in %s', (_name, locale) => {
      expect(locale.errors[InviteMessageCode.REQUIRED]).toEqual(expect.any(String));
    });

    it('should keep betaAccess as a boolean in the GET /me response schema', () => {
      expect(getMeSchema.response[200].properties.betaAccess).toMatchObject({ type: 'boolean' });
    });

    it('should not expose signupSource in the GET /me response schema', () => {
      expect(Object.keys(getMeSchema.response[200].properties)).not.toContain('signupSource');
    });
  });
});
