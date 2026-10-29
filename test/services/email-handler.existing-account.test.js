import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as emailModule from '../../src/config/email-handler.js';
import { INVITE_TTL_MS } from '../../src/constants/trainer-invite.js';

const emailHandler = emailModule.default;

const FAKE_NOW = new Date('2027-03-15T12:00:00.000Z');
const FAKE_YEAR = String(FAKE_NOW.getFullYear());
const HARDCODED_YEAR = '2026';
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const EXPIRY_DAYS = Math.round(INVITE_TTL_MS / MS_PER_DAY);

const RECIPIENT = 'bia@example.com';
const INVITE_URL = 'https://teufit.com.br/invite?code=TF-AAAA-BBBB-CC';
const CODE = 'TF-AAAA-BBBB-CC';
const EXISTING_SUBJECT = '[Teufit] Seu acesso ao teste fechado foi liberado';

describe('trainer invite emails', () => {
  let send;
  let originalClient;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(FAKE_NOW);
    originalClient = emailHandler.resendClient;
    send = vi.fn().mockResolvedValue({ id: 'email-1' });
    emailHandler.resendClient = { emails: { send } };
  });

  afterEach(() => {
    emailHandler.resendClient = originalClient;
    vi.useRealTimers();
  });

  function sentEmail() {
    return send.mock.calls[0][0];
  }

  describe('sendExistingAccountTrainerInviteEmail', () => {
    async function sendExisting(overrides = {}) {
      await emailModule.default.sendExistingAccountTrainerInviteEmail({
        to: RECIPIENT,
        code: CODE,
        inviteUrl: INVITE_URL,
        firstName: 'Bia',
        ...overrides,
      });
      return sentEmail();
    }

    it('should expose the existing-account send function on the handler', () => {
      expect(typeof emailHandler.sendExistingAccountTrainerInviteEmail).toBe('function');
    });

    it('should use the closed-test access subject', async () => {
      const { subject } = await sendExisting();

      expect(subject).toBe(EXISTING_SUBJECT);
    });

    it('should send to the recipient', async () => {
      const { to } = await sendExisting();

      expect(to).toBe(RECIPIENT);
    });

    it('should include the CTA label, invite url and code', async () => {
      const { html } = await sendExisting();

      expect(html).toContain('Ativar meu acesso');
      expect(html).toContain(INVITE_URL);
      expect(html).toContain(CODE);
    });

    it('should mention the Beta perks "alunos ilimitados e IA"', async () => {
      const { html } = await sendExisting();

      expect(html).toContain('alunos ilimitados e IA');
    });

    it('should show the recipient email in the help text', async () => {
      const { html } = await sendExisting();

      expect(html).toContain(`Entre com a conta deste e-mail (${RECIPIENT})`);
    });

    it('should greet the user by first name in the heading', async () => {
      const { html } = await sendExisting({ firstName: 'Bia' });

      expect(html).toContain('Bia, seu acesso ao Teufit foi liberado');
    });

    it('should fall back to a nameless heading without a first name', async () => {
      const { html } = await sendExisting({ firstName: null });

      expect(html).toContain('Seu acesso ao Teufit foi liberado');
    });

    it.each(['já usa', 'sua marca', 'campeonatos'])('should not contain "%s"', async (forbidden) => {
      const { html } = await sendExisting();

      expect(html.toLowerCase()).not.toContain(forbidden);
    });

    it('should derive the expiry days from INVITE_TTL_MS', async () => {
      const { html } = await sendExisting();

      expect(html).toContain(`expira em ${EXPIRY_DAYS} dias`);
    });

    it('should render the current year in the footer', async () => {
      const { html } = await sendExisting();

      expect(html).toContain(`© ${FAKE_YEAR} Teufit`);
      expect(html).not.toContain(HARDCODED_YEAR);
    });

    it('should escape html in the first name', async () => {
      const { html } = await sendExisting({ firstName: '<script>x</script>' });

      expect(html).not.toContain('<script>x</script>');
    });
  });

  describe('sendTrainerInviteEmail (new user)', () => {
    async function sendNewUser() {
      await emailHandler.sendTrainerInviteEmail({
        to: RECIPIENT,
        code: CODE,
        inviteUrl: INVITE_URL,
        invitedByName: 'Admin',
      });
      return sentEmail();
    }

    it('should derive the expiry days from INVITE_TTL_MS', async () => {
      const { html } = await sendNewUser();

      expect(html).toContain(`expira em ${EXPIRY_DAYS} dias`);
    });

    it('should render the current year in the footer', async () => {
      const { html } = await sendNewUser();

      expect(html).toContain(`© ${FAKE_YEAR} Teufit`);
      expect(html).not.toContain(HARDCODED_YEAR);
    });

    it('should keep the original new-user subject', async () => {
      const { subject } = await sendNewUser();

      expect(subject).toBe('[Teufit] Seu convite para o teste fechado');
    });
  });
});
