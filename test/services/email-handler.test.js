import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import emailHandler, { sanitizeSubjectText } from '../../src/config/email-handler.js';
import config from '../../config/index.js';

const LEGACY_BRAND_SPELLINGS = ['TreinoWay', 'Teufit', 'Treinoway'];
const BRAND = 'TeuFit';

describe('sanitizeSubjectText', () => {
  it.each([
    ['CR and LF', 'Ana\r\nCoach', 'Ana Coach'],
    ['tabs and NUL', 'Ana\t\u0000Coach', 'Ana Coach'],
    ['C1 controls', 'Ana\u0085Coach', 'Ana Coach'],
    ['unicode line/paragraph separators', 'Ana\u2028\u2029Coach', 'Ana Coach'],
    ['repeated whitespace', '  Ana    Coach  ', 'Ana Coach'],
    ['accented names', 'José Conceição', 'José Conceição'],
  ])('should normalize %s', (_label, input, expected) => {
    expect(sanitizeSubjectText(input)).toBe(expected);
  });

  it.each([[null], [undefined], [''], ['\r\n']])('should return an empty string for %j', (input) => {
    expect(sanitizeSubjectText(input)).toBe('');
  });
});

describe('email-handler rendered emails', () => {
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

  function lastEmail() {
    return send.mock.calls[0][0];
  }

  function expectNoLegacyBranding({ subject, html }) {
    for (const legacy of LEGACY_BRAND_SPELLINGS) {
      expect(subject).not.toContain(legacy);
      expect(html).not.toContain(legacy);
    }
  }

  it('should return a resolved promise (no-op) when no email client is configured', async () => {
    emailHandler.resendClient = null;

    await expect(emailHandler.sendStudentInviteEmail({ to: 'a@b.com', trainerName: 'Ana' })).resolves.toBeUndefined();
    await expect(emailHandler.sendEmailVerificationEmail({ to: 'a@b.com', code: '123456' })).resolves.toBeUndefined();
    await expect(
      emailHandler.sendExistingUserStudentInviteEmail({ to: 'a@b.com', trainerName: 'Ana', code: '123456' }),
    ).resolves.toBeUndefined();
  });

  describe('sendStudentInviteEmail', () => {
    beforeEach(async () => {
      await emailHandler.sendStudentInviteEmail({ to: 'student@example.com', trainerName: 'Ana Coach' });
    });

    it('should address the student and mention the trainer and the TeuFit brand', () => {
      const { to, subject, html } = lastEmail();
      expect(to).toBe('student@example.com');
      expect(subject).toContain(BRAND);
      expect(html).toContain('Ana Coach');
      expect(html).toContain(BRAND);
    });

    it('should not contain legacy brand spellings', () => {
      expectNoLegacyBranding(lastEmail());
    });

    it('should include the App Store and Google Play links', () => {
      const { html } = lastEmail();
      expect(html).toContain(config.stores.appStoreUrl);
      expect(html).toContain(config.stores.playStoreUrl);
    });

    it.each([
      ['LF', 'Ana\nBcc: evil@example.com'],
      ['CRLF', 'Ana\r\nBcc: evil@example.com'],
      ['NUL and other control chars', 'Ana\u0000\u0007Bcc: evil@example.com'],
    ])('should keep the subject on a single line when the trainer name contains %s', async (_label, trainerName) => {
      send.mockClear();
      await emailHandler.sendStudentInviteEmail({ to: 'a@b.com', trainerName });

      expect(lastEmail().subject).not.toMatch(/[\u0000-\u001F\u007F-\u009F]/);
      expect(lastEmail().subject).toContain('Ana Bcc: evil@example.com');
    });

    it('should use the generic subject when the trainer name has no printable characters', async () => {
      send.mockClear();
      await emailHandler.sendStudentInviteEmail({ to: 'a@b.com', trainerName: '\r\n\t' });

      expect(lastEmail().subject).toBe('[TeuFit] Você foi convidado para o time do seu treinador');
    });

    it('should HTML-escape the trainer name', async () => {
      send.mockClear();
      await emailHandler.sendStudentInviteEmail({ to: 'a@b.com', trainerName: '<script>alert(1)</script>' });

      expect(lastEmail().html).not.toContain('<script>alert(1)</script>');
    });
  });

  describe('sendExistingUserStudentInviteEmail', () => {
    const CODE = '048213';
    const NO_CODE_TEXT = 'peça um novo na tela de confirmação';

    it('should address the student, mention the trainer and the TeuFit brand only', async () => {
      await emailHandler.sendExistingUserStudentInviteEmail({
        to: 'student@example.com',
        trainerName: 'Ana Coach',
        code: CODE,
      });

      const { to, subject, html } = lastEmail();
      expect(to).toBe('student@example.com');
      expect(subject).toBe('[TeuFit] Ana Coach convidou você para o time');
      expect(html).toContain('Ana Coach');
      expectNoLegacyBranding(lastEmail());
    });

    it('should render the verification code and not the no-code text when a code is given', async () => {
      await emailHandler.sendExistingUserStudentInviteEmail({ to: 'a@b.com', trainerName: 'Ana', code: CODE });

      expect(lastEmail().html).toContain(CODE);
      expect(lastEmail().html).not.toContain(NO_CODE_TEXT);
    });

    it('should render the no-code variant when the code is null', async () => {
      await emailHandler.sendExistingUserStudentInviteEmail({ to: 'a@b.com', trainerName: 'Ana', code: null });

      expect(lastEmail().html).toContain(NO_CODE_TEXT);
      expect(lastEmail().html).not.toContain('letter-spacing: 0.35em');
    });

    it('should HTML-escape the code', async () => {
      await emailHandler.sendExistingUserStudentInviteEmail({
        to: 'a@b.com',
        trainerName: 'Ana',
        code: '<b>1</b>',
      });

      expect(lastEmail().html).not.toContain('<b>1</b>');
      expect(lastEmail().html).toContain('&lt;b&gt;1&lt;/b&gt;');
    });

    it('should include the App Store and Google Play links', async () => {
      await emailHandler.sendExistingUserStudentInviteEmail({ to: 'a@b.com', trainerName: 'Ana', code: CODE });

      expect(lastEmail().html).toContain(config.stores.appStoreUrl);
      expect(lastEmail().html).toContain(config.stores.playStoreUrl);
    });

    it('should keep the subject on a single line and escape the trainer name in the html', async () => {
      await emailHandler.sendExistingUserStudentInviteEmail({
        to: 'a@b.com',
        trainerName: 'Ana\r\nBcc: <script>x</script>',
        code: CODE,
      });

      expect(lastEmail().subject).not.toMatch(/[\u0000-\u001F\u007F-\u009F]/);
      expect(lastEmail().html).not.toContain('<script>x</script>');
    });

    it('should use the generic subject when the trainer name has no printable characters', async () => {
      await emailHandler.sendExistingUserStudentInviteEmail({ to: 'a@b.com', trainerName: '\r\n', code: CODE });

      expect(lastEmail().subject).toBe('[TeuFit] Você foi convidado para o time do seu treinador');
    });
  });

  describe('sendStudentLinkedEmail', () => {
    beforeEach(async () => {
      await emailHandler.sendStudentLinkedEmail({ to: 'student@example.com', trainerName: 'Ana Coach' });
    });

    it('should include the store links and the TeuFit brand only', () => {
      const { html } = lastEmail();
      expect(html).toContain(config.stores.appStoreUrl);
      expect(html).toContain(config.stores.playStoreUrl);
      expectNoLegacyBranding(lastEmail());
    });
  });

  describe('sendAnamnesisAssignedEmail', () => {
    const sendAssigned = (overrides = {}) =>
      emailHandler.sendAnamnesisAssignedEmail({
        to: 'student@example.com',
        studentName: 'Maria',
        trainerName: 'Ana Coach',
        anamnesisTitle: 'Saúde e histórico',
        ...overrides,
      });

    it('should address the student with the trainer in the subject', async () => {
      await sendAssigned();

      const { to, subject } = lastEmail();
      expect(to).toBe('student@example.com');
      expect(subject).toBe('[TeuFit] Nova anamnese de Ana Coach');
    });

    it('should render the title and send the student to the mobile app, never to the web', async () => {
      await sendAssigned();

      const { html } = lastEmail();
      expect(html).toContain('Saúde e histórico');
      expect(html).toContain('Responda pelo app TeuFit');
      expect(html).toContain(config.stores.appStoreUrl);
      expect(html).toContain(config.stores.playStoreUrl);
      expect(html).not.toContain('/my/anamneses');
      expectNoLegacyBranding(lastEmail());
    });

    it('should use the TeuFit lockup logo in the header, like the other transactional emails', async () => {
      await sendAssigned();

      const { html } = lastEmail();
      expect(html).toContain('https://teufit.com.br/img/teufit-lockup.png');
      expect(html).not.toMatch(/<h1[^>]*>\s*TEUFIT\s*<\/h1>/);
    });

    it('should keep an imperative voice without greetings or "Por favor"', async () => {
      await sendAssigned();

      const { html } = lastEmail();
      expect(html).not.toMatch(/Olá|Por favor|Bem-vindo/i);
    });

    it('should fall back to a generic subject and heading without names', async () => {
      await sendAssigned({ trainerName: '\r\n', studentName: undefined });

      const { subject, html } = lastEmail();
      expect(subject).toBe('[TeuFit] Nova anamnese do seu treinador');
      expect(html).toContain('Responda a nova anamnese');
      expect(html).toContain('Seu treinador enviou a anamnese');
    });

    it('should keep the subject on a single line when the trainer name contains CR/LF', async () => {
      await sendAssigned({ trainerName: 'Ana\r\nBcc: evil@example.com' });

      expect(lastEmail().subject).not.toMatch(/[\u0000-\u001F\u007F-\u009F]/);
    });

    it('should HTML-escape user-controlled text', async () => {
      await sendAssigned({
        trainerName: '<b>Ana</b>',
        studentName: '<i>Maria</i>',
        anamnesisTitle: '<script>alert(1)</script>',
      });

      const { html } = lastEmail();
      expect(html).not.toContain('<script>alert(1)</script>');
      expect(html).not.toContain('<b>Ana</b>');
      expect(html).not.toContain('<i>Maria</i>');
    });

    it('should be a no-op when no email client is configured', async () => {
      emailHandler.resendClient = null;

      await expect(sendAssigned()).resolves.toBeUndefined();
    });
  });

  describe('sendEmailVerificationEmail', () => {
    it('should render the 6-digit code and only the TeuFit brand', async () => {
      await emailHandler.sendEmailVerificationEmail({ to: 'student@example.com', code: '048213' });

      const { to, html } = lastEmail();
      expect(to).toBe('student@example.com');
      expect(html).toContain('048213');
      expectNoLegacyBranding(lastEmail());
    });
  });

  describe('sendExistingAccountSignupEmail', () => {
    it('should tell the owner to sign in or reset the password, without a code', async () => {
      await emailHandler.sendExistingAccountSignupEmail({ to: 'owner@example.com' });

      const { to, subject, html } = lastEmail();
      expect(to).toBe('owner@example.com');
      expect(subject).toBe('[TeuFit] Você já tem uma conta');
      expect(html).toContain('Esqueci minha senha');
      expect(html).not.toMatch(/\b[0-9]{6}\b/);
      expectNoLegacyBranding(lastEmail());
    });

    it('should return a resolved promise (no-op) when no email client is configured', async () => {
      emailHandler.resendClient = null;

      await expect(emailHandler.sendExistingAccountSignupEmail({ to: 'owner@example.com' })).resolves.toBeUndefined();
    });
  });

  describe.each([
    ['sendResetPasswordEmail', { to: 'a@b.com', passwordToken: '123456' }],
    ['sendWaitlistConfirmationEmail', { to: 'a@b.com' }],
    [
      'sendTrainerInviteEmail',
      { to: 'a@b.com', code: 'TF-AAAA-BBBB-CC', inviteUrl: 'https://teufit.com.br/invite', invitedByName: 'Admin' },
    ],
  ])('%s', (method, payload) => {
    it('should not contain legacy brand spellings', async () => {
      await emailHandler[method](payload);

      expectNoLegacyBranding(lastEmail());
    });
  });
});
