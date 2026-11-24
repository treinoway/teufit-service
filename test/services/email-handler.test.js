import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import emailHandler, { sanitizeSubjectText } from '../../src/config/email-handler.js';
import config from '../../config/index.js';

// `Teufit` (capital T, lowercase f) is the canonical spelling — it matches the App Store
// listing, the teufit@ work address and the store docs. `TeuFit` is a past in-house
// variant and is treated as a regression, like the older Treinoway names.
const LEGACY_BRAND_SPELLINGS = ['TreinoWay', 'Treinoway', 'TeuFit'];
const BRAND = 'Teufit';

// Published listings. The App Store link is the id-only form on purpose: the listing slug
// is still `teufit-production`, and Apple resolves by numeric id while ignoring the slug.
const APP_STORE_URL = 'https://apps.apple.com/br/app/id6809516404';
const PLAY_STORE_URL = 'https://play.google.com/store/apps/details?id=br.com.teufit.app';

// The web app lives on the app subdomain; the root domain is the landing page and must no
// longer serve email images.
const WEB_APP_BASE_URL = 'https://app.teufit.com.br';
const ROOT_DOMAIN_IMG_PREFIX = 'https://teufit.com.br/img/';

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

describe('store listing links (config.stores)', () => {
  it('should default to the published App Store listing', () => {
    expect(config.stores.appStoreUrl).toBe(APP_STORE_URL);
  });

  it('should default to the published Google Play listing', () => {
    expect(config.stores.playStoreUrl).toBe(PLAY_STORE_URL);
  });

  it('should not ship a placeholder Apple id', () => {
    expect(config.stores.appStoreUrl).not.toContain('id0000000000');
    expect(config.stores.appStoreUrl).toMatch(/\/id[1-9][0-9]+$/);
  });

  it('should keep the App Store link free of the listing slug', () => {
    expect(config.stores.appStoreUrl).not.toContain('teufit-production');
    expect(config.stores.appStoreUrl).toMatch(/^https:\/\/apps\.apple\.com\/br\/app\/id[0-9]+$/);
  });
});

describe('web app base URL (config.web)', () => {
  it('should default to the app subdomain', () => {
    expect(config.web.baseUrl).toBe(WEB_APP_BASE_URL);
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

    it('should address the student and mention the trainer and the Teufit brand', () => {
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
      expect(html).toContain(APP_STORE_URL);
      expect(html).toContain(PLAY_STORE_URL);
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

      expect(lastEmail().subject).toBe('[Teufit] Você foi convidado para o time do seu treinador');
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

    it('should address the student, mention the trainer and the Teufit brand only', async () => {
      await emailHandler.sendExistingUserStudentInviteEmail({
        to: 'student@example.com',
        trainerName: 'Ana Coach',
        code: CODE,
      });

      const { to, subject, html } = lastEmail();
      expect(to).toBe('student@example.com');
      expect(subject).toBe('[Teufit] Ana Coach convidou você para o time');
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

      expect(lastEmail().html).toContain(APP_STORE_URL);
      expect(lastEmail().html).toContain(PLAY_STORE_URL);
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

      expect(lastEmail().subject).toBe('[Teufit] Você foi convidado para o time do seu treinador');
    });
  });

  describe('sendStudentInviteOpenAppEmail', () => {
    const sendOpenApp = (trainerName = 'Ana Coach') =>
      emailHandler.sendStudentInviteOpenAppEmail({ to: 'student@example.com', trainerName });

    it('should name the trainer in the subject and the heading', async () => {
      await sendOpenApp();

      const { to, subject, html } = lastEmail();
      expect(to).toBe('student@example.com');
      expect(subject).toBe('[Teufit] Ana Coach te convidou no Teufit');
      expect(html).toContain('Ana Coach te convidou no Teufit');
    });

    it('should tell the student to open the app, updated, to accept or decline', async () => {
      await sendOpenApp();

      const { html } = lastEmail();
      expect(html).toContain('Abra o app Teufit');
      expect(html).toContain('aceitar ou recusar');
      expect(html).toContain('atualize o app');
    });

    it('should carry the store badges and no closed-beta wording or legacy brand', async () => {
      await sendOpenApp();

      const { html } = lastEmail();
      expect(html).toContain(APP_STORE_URL);
      expect(html).toContain(PLAY_STORE_URL);
      expect(html).not.toMatch(/teste fechado/i);
      expectNoLegacyBranding(lastEmail());
    });

    it('should load the store badge images from the web app base URL', async () => {
      await sendOpenApp();

      const { html } = lastEmail();
      expect(html).toContain(`${config.web.baseUrl}/img/app-store-badge-pt-br.png`);
      expect(html).toContain(`${config.web.baseUrl}/img/google-play-badge-pt-br.png`);
      expect(html).not.toContain(ROOT_DOMAIN_IMG_PREFIX);
    });

    it('should fall back to a generic trainer label and keep the subject on one line', async () => {
      await sendOpenApp('\r\n');

      const { subject, html } = lastEmail();
      expect(subject).toBe('[Teufit] Seu treinador te convidou no Teufit');
      expect(html).toContain('Seu treinador te convidou no Teufit');
    });

    it('should escape HTML in the trainer name', async () => {
      await sendOpenApp('<b>Ana</b>');

      expect(lastEmail().html).not.toContain('<b>Ana</b>');
    });
  });

  describe('sendStudentLinkedEmail', () => {
    beforeEach(async () => {
      await emailHandler.sendStudentLinkedEmail({ to: 'student@example.com', trainerName: 'Ana Coach' });
    });

    it('should include the store links and the Teufit brand only', () => {
      const { html } = lastEmail();
      expect(html).toContain(APP_STORE_URL);
      expect(html).toContain(PLAY_STORE_URL);
      expectNoLegacyBranding(lastEmail());
    });

    it('should no longer mention the closed beta', () => {
      const { subject, html } = lastEmail();
      expect(subject).not.toMatch(/teste fechado/i);
      expect(html).not.toMatch(/teste fechado/i);
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
      expect(subject).toBe('[Teufit] Nova anamnese de Ana Coach');
    });

    it('should render the title and send the student to the mobile app, never to the web', async () => {
      await sendAssigned();

      const { html } = lastEmail();
      expect(html).toContain('Saúde e histórico');
      expect(html).toContain('Responda pelo app Teufit');
      expect(html).toContain(APP_STORE_URL);
      expect(html).toContain(PLAY_STORE_URL);
      expect(html).not.toContain('/my/anamneses');
      expectNoLegacyBranding(lastEmail());
    });

    it('should use the Teufit lockup logo in the header, like the other transactional emails', async () => {
      await sendAssigned();

      const { html } = lastEmail();
      expect(html).toContain(`${config.web.baseUrl}/img/teufit-lockup.png`);
      expect(html).not.toContain(ROOT_DOMAIN_IMG_PREFIX);
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
      expect(subject).toBe('[Teufit] Nova anamnese do seu treinador');
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
    it('should render the 6-digit code and only the Teufit brand', async () => {
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
      expect(subject).toBe('[Teufit] Você já tem uma conta');
      expect(html).toContain('Esqueci minha senha');
      expect(html).not.toMatch(/\b[0-9]{6}\b/);
      expectNoLegacyBranding(lastEmail());
    });

    it('should return a resolved promise (no-op) when no email client is configured', async () => {
      emailHandler.resendClient = null;

      await expect(emailHandler.sendExistingAccountSignupEmail({ to: 'owner@example.com' })).resolves.toBeUndefined();
    });
  });

  // why: every public send* method, so a new email template cannot reintroduce `TeuFit`.
  describe.each([
    ['sendResetPasswordEmail', { to: 'a@b.com', passwordToken: '123456' }],
    ['sendWaitlistConfirmationEmail', { to: 'a@b.com' }],
    ['sendStudentLinkedEmail', { to: 'a@b.com', trainerName: 'Ana' }],
    [
      'sendTrainerInviteEmail',
      { to: 'a@b.com', code: 'TF-AAAA-BBBB-CC', inviteUrl: 'https://teufit.com.br/invite', invitedByName: 'Admin' },
    ],
    ['sendStudentInviteEmail', { to: 'a@b.com', trainerName: 'Ana' }],
    ['sendExistingUserStudentInviteEmail', { to: 'a@b.com', trainerName: 'Ana', code: '048213' }],
    ['sendEmailVerificationEmail', { to: 'a@b.com', code: '048213' }],
    ['sendExistingAccountSignupEmail', { to: 'a@b.com' }],
    [
      'sendAnamnesisAssignedEmail',
      { to: 'a@b.com', studentName: 'Maria', trainerName: 'Ana', anamnesisTitle: 'Saúde' },
    ],
  ])('%s', (method, payload) => {
    it('should spell the brand as Teufit in the body', async () => {
      await emailHandler[method](payload);

      expect(lastEmail().html).toContain(BRAND);
    });

    it('should not contain legacy brand spellings', async () => {
      await emailHandler[method](payload);

      expectNoLegacyBranding(lastEmail());
    });
  });
});

describe('email-handler sendTrainerWelcomeEmail', () => {
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

  it('should send one email to the trainer with the Teufit brand in subject and html', async () => {
    await emailHandler.sendTrainerWelcomeEmail({ to: 'trainer@example.com', firstName: 'Bia' });

    expect(send).toHaveBeenCalledTimes(1);
    const { to, subject, html } = send.mock.calls[0][0];
    expect(to).toBe('trainer@example.com');
    expect(subject).toContain(BRAND);
    expect(html).toContain(BRAND);
  });

  it('should greet the trainer by first name', async () => {
    await emailHandler.sendTrainerWelcomeEmail({ to: 'trainer@example.com', firstName: 'Bia' });

    expect(send.mock.calls[0][0].html).toContain('Bia');
  });

  it('should HTML-escape the first name', async () => {
    await emailHandler.sendTrainerWelcomeEmail({ to: 'trainer@example.com', firstName: '<script>x</script>' });

    expect(send.mock.calls[0][0].html).not.toContain('<script>x</script>');
  });

  it('should still send when the trainer has no first name', async () => {
    await emailHandler.sendTrainerWelcomeEmail({ to: 'trainer@example.com', firstName: null });

    expect(send).toHaveBeenCalledTimes(1);
  });

  it('should not contain legacy brand spellings', async () => {
    await emailHandler.sendTrainerWelcomeEmail({ to: 'trainer@example.com', firstName: 'Bia' });

    const { subject, html } = send.mock.calls[0][0];
    for (const legacy of LEGACY_BRAND_SPELLINGS) {
      expect(subject).not.toContain(legacy);
      expect(html).not.toContain(legacy);
    }
  });

  it('should resolve to undefined (no-op) when no email client is configured', async () => {
    emailHandler.resendClient = null;

    await expect(
      emailHandler.sendTrainerWelcomeEmail({ to: 'trainer@example.com', firstName: 'Bia' }),
    ).resolves.toBeUndefined();
  });
});
