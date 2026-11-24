import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/db.js', () => ({
  prisma: {
    trainerInvite: { findFirst: vi.fn() },
    refreshToken: { create: vi.fn() },
  },
}));

vi.mock('../../src/services/user-service.js', async (importOriginal) => ({
  ...(await importOriginal()),
  setActiveProfileToTrainer: vi.fn(),
  setActiveProfileToNutritionist: vi.fn(),
  getUserProfileById: vi.fn(),
}));

import { prisma } from '../../src/db.js';
import config from '../../config/index.js';
import { setupApp } from '../helpers/setup-app.js';
import { Roles } from '../../src/constants/roles.js';
import { UserStatus } from '../../src/constants/user-status.js';
import {
  getUserProfileById,
  setActiveProfileToNutritionist,
  setActiveProfileToTrainer,
} from '../../src/services/user-service.js';

const USER_ID = '7d0f2b1c-6f0e-4a55-9f0e-0c1d2e3f4a5b';
const USER_EMAIL = 'no.invite@example.com';
const INVITE_REQUIRED = 'INVITE_REQUIRED';

describe('profession routes no longer require a beta invite', () => {
  let app;
  let accessToken;
  const originalGateEnabled = config.betaInviteGate.enabled;

  beforeAll(async () => {
    app = await setupApp();
    await app.ready();
    accessToken = app.jwt.sign({ sub: USER_ID, email: USER_EMAIL, roles: [], status: UserStatus.ACTIVE });
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(() => {
    config.betaInviteGate.enabled = true;
    prisma.trainerInvite.findFirst.mockResolvedValue(null);
    prisma.refreshToken.create.mockResolvedValue({ id: 'refresh-1' });
  });

  afterEach(() => {
    config.betaInviteGate.enabled = originalGateEnabled;
  });

  const patch = (url, headers = { authorization: `Bearer ${accessToken}` }) => app.inject({ method: 'PATCH', url, headers });

  describe.each([
    ['/become-trainer', Roles.TRAINER, setActiveProfileToTrainer],
    ['/become-nutritionist', Roles.NUTRITIONIST, setActiveProfileToNutritionist],
  ])('PATCH %s with the beta invite gate flag enabled', (url, role, setActiveProfile) => {
    beforeEach(() => {
      setActiveProfile.mockResolvedValue({ userId: USER_ID, activeProfile: role });
      getUserProfileById.mockResolvedValue({ id: USER_ID, email: USER_EMAIL, roles: [role], status: UserStatus.ACTIVE });
    });

    it('should answer 200 for an authenticated user who never redeemed an invite', async () => {
      const res = await patch(url);

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        activeProfile: role,
        token: { accessToken: expect.any(String) },
        refreshToken: expect.any(String),
      });
    });

    it('should never answer INVITE_REQUIRED', async () => {
      const res = await patch(url);

      expect(res.json().error).not.toBe(INVITE_REQUIRED);
    });

    it('should grant the profile to the authenticated user', async () => {
      await patch(url);

      expect(setActiveProfile).toHaveBeenCalledTimes(1);
      expect(setActiveProfile.mock.calls[0][0]).toBe(USER_ID);
    });

    it('should still answer 401 without authentication', async () => {
      const res = await patch(url, {});

      expect(res.statusCode).toBe(401);
      expect(setActiveProfile).not.toHaveBeenCalled();
    });
  });
});
