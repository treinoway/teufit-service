import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db.js', () => ({
  prisma: {
    trainerInvite: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
    },
    user: { findUnique: vi.fn(), findFirst: vi.fn() },
    trainer: { findUnique: vi.fn() },
    platformSubscription: { findUnique: vi.fn(), upsert: vi.fn() },
    $queryRaw: vi.fn(),
    $transaction: vi.fn(async (ops) => (typeof ops === 'function' ? ops(prisma) : ops)),
  },
}));
vi.mock('../../src/services/user-service.js', () => ({ setActiveProfileToTrainer: vi.fn() }));
vi.mock('../../src/services/platform-plan-service.js', () => ({
  reactivateStudentsUpToCap: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/services/email-verification-service.js', () => ({ markEmailVerifiedFromInboxProof: vi.fn() }));
vi.mock('../../src/config/email-handler.js', () => ({
  default: {
    sendTrainerInviteEmail: vi.fn(),
    sendExistingAccountTrainerInviteEmail: vi.fn(),
  },
}));

import { prisma } from '../../src/db.js';
import emailHandler from '../../src/config/email-handler.js';
import { InviteStatus } from '../../src/constants/trainer-invite.js';
import { createInvite } from '../../src/services/trainer-invite-service.js';

const ADMIN_ID = 'admin-1';
const EXISTING_USER_ID = 'user-1';
const INVITEE_EMAIL = 'invitee@example.com';

// Builds the invite row `trainerInvite.create` echoes back.
function echoCreatedInvite({ data }) {
  return Promise.resolve({ id: 'invite-1', status: InviteStatus.PENDING, createdAt: new Date(), ...data });
}

describe('createInvite email variant', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.trainerInvite.findFirst.mockResolvedValue(null);
    prisma.trainerInvite.updateMany.mockResolvedValue({ count: 0 });
    prisma.trainerInvite.create.mockImplementation(echoCreatedInvite);
    prisma.user.findUnique.mockResolvedValue({ firstName: 'Ada', lastName: 'Lovelace' });
    prisma.user.findFirst.mockResolvedValue(null);
    emailHandler.sendTrainerInviteEmail.mockResolvedValue(undefined);
    emailHandler.sendExistingAccountTrainerInviteEmail.mockResolvedValue(undefined);
  });

  describe('when the email belongs to an existing account', () => {
    beforeEach(() => {
      prisma.user.findFirst.mockResolvedValue({ id: EXISTING_USER_ID, email: INVITEE_EMAIL, firstName: 'Bia' });
    });

    it('should send the existing-account email with recipient, code and invite url', async () => {
      const { code } = await createInvite({ actingUserId: ADMIN_ID, email: INVITEE_EMAIL });

      expect(emailHandler.sendExistingAccountTrainerInviteEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: INVITEE_EMAIL,
          code,
          inviteUrl: expect.stringContaining(`/invite?code=${encodeURIComponent(code)}`),
        })
      );
    });

    it('should not send the new-user invite email', async () => {
      await createInvite({ actingUserId: ADMIN_ID, email: INVITEE_EMAIL });

      expect(emailHandler.sendTrainerInviteEmail).not.toHaveBeenCalled();
    });

    it('should look the user up case-insensitively and ignore deleted users', async () => {
      await createInvite({ actingUserId: ADMIN_ID, email: 'Invitee@Example.COM' });

      const lookup = JSON.stringify(prisma.user.findFirst.mock.calls[0][0].where);
      expect(lookup).toContain('"mode":"insensitive"');
      expect(lookup).toContain('"deletedAt":null');
    });

    it('should keep the response shape { invite, code }', async () => {
      const result = await createInvite({ actingUserId: ADMIN_ID, email: INVITEE_EMAIL });

      expect(Object.keys(result).sort()).toEqual(['code', 'invite']);
    });

    it('should not fail the invite when the existing-account email send rejects', async () => {
      emailHandler.sendExistingAccountTrainerInviteEmail.mockRejectedValue(new Error('resend down'));
      vi.spyOn(console, 'error').mockImplementation(() => {});

      await expect(createInvite({ actingUserId: ADMIN_ID, email: INVITEE_EMAIL })).resolves.toHaveProperty('code');
    });
  });

  describe('when no account exists for the email', () => {
    it('should send the new-user invite email', async () => {
      const { code } = await createInvite({ actingUserId: ADMIN_ID, email: INVITEE_EMAIL });

      expect(emailHandler.sendTrainerInviteEmail).toHaveBeenCalledWith(
        expect.objectContaining({ to: INVITEE_EMAIL, code })
      );
    });

    it('should not send the existing-account email', async () => {
      await createInvite({ actingUserId: ADMIN_ID, email: INVITEE_EMAIL });

      expect(emailHandler.sendExistingAccountTrainerInviteEmail).not.toHaveBeenCalled();
    });
  });
});
