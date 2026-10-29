import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db.js', () => ({
  prisma: {
    trainerInvite: { findFirst: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
    user: { findUnique: vi.fn(), findFirst: vi.fn() },
    $transaction: vi.fn(async (operation) => operation(prisma)),
  },
}));
vi.mock('../../src/services/user-service.js', () => ({ setActiveProfileToTrainer: vi.fn() }));
vi.mock('../../src/services/platform-plan-service.js', () => ({
  reactivateStudentsUpToCap: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/services/email-verification-service.js', () => ({ markEmailVerifiedFromInboxProof: vi.fn() }));
vi.mock('../../src/config/email-handler.js', () => ({
  default: { sendTrainerInviteEmail: vi.fn(), sendExistingAccountTrainerInviteEmail: vi.fn() },
}));

import { prisma } from '../../src/db.js';
import emailHandler from '../../src/config/email-handler.js';
import { InviteStatus } from '../../src/constants/trainer-invite.js';
import { createInvite } from '../../src/services/trainer-invite-service.js';

const WILDCARD_EMAIL = 'inv_tee@example.com';

describe('createInvite with a wildcard-matching account', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.trainerInvite.findFirst.mockResolvedValue(null);
    prisma.trainerInvite.updateMany.mockResolvedValue({ count: 0 });
    prisma.trainerInvite.create.mockImplementation(({ data }) =>
      Promise.resolve({ id: 'invite-1', status: InviteStatus.PENDING, createdAt: new Date(), ...data })
    );
    prisma.user.findUnique.mockResolvedValue({ firstName: 'Ada', lastName: 'Lovelace' });
    prisma.user.findFirst.mockResolvedValue({ id: 'u-2', email: 'invXtee@example.com', firstName: 'Zed' });
    emailHandler.sendTrainerInviteEmail.mockResolvedValue(undefined);
  });

  it('should send the new-user email when the matched account has a different email', async () => {
    await createInvite({ actingUserId: 'admin-1', email: WILDCARD_EMAIL });

    expect(emailHandler.sendTrainerInviteEmail).toHaveBeenCalled();
    expect(emailHandler.sendExistingAccountTrainerInviteEmail).not.toHaveBeenCalled();
  });
});
