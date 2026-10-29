import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const MOCK_TTL_DAYS = 3;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

vi.mock('../../src/constants/trainer-invite.js', async (importOriginal) => ({
  ...(await importOriginal()),
  INVITE_TTL_MS: 3 * 24 * 60 * 60 * 1000,
}));

import emailHandler from '../../src/config/email-handler.js';
import * as trainerInviteConstants from '../../src/constants/trainer-invite.js';

const PAYLOAD = { to: 'a@b.com', code: 'TF-AAAA-BBBB-CC', inviteUrl: 'https://teufit.com.br/invite' };

describe('trainer invite emails expiry text follows INVITE_TTL_MS', () => {
  let send;
  let originalClient;

  beforeEach(() => {
    originalClient = emailHandler.resendClient;
    send = vi.fn().mockResolvedValue({ id: 'email-1' });
    emailHandler.resendClient = { emails: { send } };
  });

  afterEach(() => {
    emailHandler.resendClient = originalClient;
  });

  it('should use the mocked TTL constant', () => {
    expect(trainerInviteConstants.INVITE_TTL_MS).toBe(MOCK_TTL_DAYS * MS_PER_DAY);
  });

  it('should state the TTL days in the new-user invite email', async () => {
    await emailHandler.sendTrainerInviteEmail(PAYLOAD);

    expect(send.mock.calls[0][0].html).toContain(`expira em ${MOCK_TTL_DAYS} dias`);
  });

  it('should state the TTL days in the existing-account invite email', async () => {
    await emailHandler.sendExistingAccountTrainerInviteEmail({ ...PAYLOAD, firstName: 'Bia' });

    expect(send.mock.calls[0][0].html).toContain(`expira em ${MOCK_TTL_DAYS} dias`);
  });
});
