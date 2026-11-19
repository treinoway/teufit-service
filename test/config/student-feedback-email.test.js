import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import emailHandler from '../../src/config/email-handler.js';
import { RESPONSE_WINDOW_DAYS } from '../../src/constants/student-feedback.js';

const TO = 'ana@example.com';

describe('student feedback e-mails', () => {
  let send;
  let originalClient;

  beforeEach(() => {
    originalClient = emailHandler.resendClient;
    send = vi.fn().mockResolvedValue({ data: { id: 'email-1' }, error: null });
    emailHandler.resendClient = { emails: { send } };
  });

  afterEach(() => {
    emailHandler.resendClient = originalClient;
  });

  describe('sendStudentFeedbackRequestEmail', () => {
    it('sends to the student with the trainer in the subject and the answer window in the body', async () => {
      await emailHandler.sendStudentFeedbackRequestEmail({ to: TO, studentName: 'Ana', trainerName: 'Rafael Silva' });

      expect(send).toHaveBeenCalledTimes(1);
      const [email] = send.mock.calls[0];
      expect(email.to).toBe(TO);
      expect(email.subject).toBe('[Teufit] Rafael Silva pediu seu feedback');
      expect(email.html).toContain('Ana, conte como está seu processo');
      expect(email.html).toContain(`${RESPONSE_WINDOW_DAYS} dias`);
    });

    it('falls back to a generic subject and heading without names', async () => {
      await emailHandler.sendStudentFeedbackRequestEmail({ to: TO, studentName: null, trainerName: '' });

      const [email] = send.mock.calls[0];
      expect(email.subject).toBe('[Teufit] Seu treinador pediu seu feedback');
      expect(email.html).toContain('Conte como está seu processo');
      expect(email.html).toContain('Seu treinador quer saber');
    });

    it('escapes names in the body and strips line breaks from the subject', async () => {
      await emailHandler.sendStudentFeedbackRequestEmail({ to: TO, studentName: '<b>Ana</b>', trainerName: 'Rafa\r\nBcc: x@example.com <script>' });

      const [email] = send.mock.calls[0];
      expect(email.subject).not.toMatch(/[\r\n]/);
      expect(email.html).not.toContain('<b>Ana</b>');
      expect(email.html).not.toContain('<script>');
    });
  });

  describe('sendStudentFeedbackReminderEmail', () => {
    it('sends the reminder to the student naming the trainer', async () => {
      await emailHandler.sendStudentFeedbackReminderEmail({ to: TO, studentName: 'Ana', trainerName: 'Rafael Silva' });

      expect(send).toHaveBeenCalledTimes(1);
      const [email] = send.mock.calls[0];
      expect(email.to).toBe(TO);
      expect(email.subject).toBe('[Teufit] Lembrete: seu feedback está pendente');
      expect(email.html).toContain('Ana, seu feedback ainda está pendente');
      expect(email.html).toContain('O feedback que Rafael Silva pediu');
    });

    it('does nothing without a configured client', async () => {
      emailHandler.resendClient = null;

      await expect(emailHandler.sendStudentFeedbackReminderEmail({ to: TO, studentName: 'Ana', trainerName: 'Rafael' })).resolves.toBeUndefined();
      expect(send).not.toHaveBeenCalled();
    });
  });
});
