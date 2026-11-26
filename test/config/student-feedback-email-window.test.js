import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import emailHandler from '../../src/config/email-handler.js';
import { RESPONSE_WINDOW_DAYS, RESPONSE_WINDOW_MAX_DAYS, RESPONSE_WINDOW_MIN_DAYS } from '../../src/constants/student-feedback.js';

const TO = 'ana@example.com';
const RECIPIENT = Object.freeze({ to: TO, studentName: 'Ana', trainerName: 'Rafael Silva' });
const CHOSEN_WINDOW_DAYS = 5;
const ONE_DAY_TEXT = /em até <strong>1 dia<\/strong>/;
const ANY_PLURAL_DEADLINE = /em até <strong>\d+ dias<\/strong>/;

// Deadline sentence of the request e-mail for a window of several days
function pluralDeadline(days) {
  return `em até <strong>${days} dias</strong>`;
}

let send;
let originalClient;

// Sends the request e-mail with the given extra payload and returns the HTML handed to the provider
async function htmlOf(extra) {
  await emailHandler.sendStudentFeedbackRequestEmail({ ...RECIPIENT, ...extra });
  return send.mock.calls[0][0].html;
}

describe('student feedback request e-mail: response window', () => {
  beforeEach(() => {
    originalClient = emailHandler.resendClient;
    send = vi.fn().mockResolvedValue({ data: { id: 'email-1' }, error: null });
    emailHandler.resendClient = { emails: { send } };
  });

  afterEach(() => {
    emailHandler.resendClient = originalClient;
  });

  it('states the number of days of the trainer', async () => {
    const html = await htmlOf({ responseWindowDays: CHOSEN_WINDOW_DAYS });

    expect(html).toContain(pluralDeadline(CHOSEN_WINDOW_DAYS));
  });

  it('does not state the default window when the trainer chose another one', async () => {
    const html = await htmlOf({ responseWindowDays: CHOSEN_WINDOW_DAYS });

    expect(html).not.toContain(pluralDeadline(RESPONSE_WINDOW_DAYS));
  });

  it('states the longest window', async () => {
    const html = await htmlOf({ responseWindowDays: RESPONSE_WINDOW_MAX_DAYS });

    expect(html).toContain(pluralDeadline(RESPONSE_WINDOW_MAX_DAYS));
  });

  it('uses the singular for a window of one day', async () => {
    const html = await htmlOf({ responseWindowDays: RESPONSE_WINDOW_MIN_DAYS });

    expect(html).toMatch(ONE_DAY_TEXT);
  });

  it('never writes "1 dias"', async () => {
    const html = await htmlOf({ responseWindowDays: RESPONSE_WINDOW_MIN_DAYS });

    expect(html).not.toMatch(ANY_PLURAL_DEADLINE);
    expect(html).not.toContain('1 dias');
  });

  it('falls back to the default window when the payload has no window', async () => {
    const html = await htmlOf({});

    expect(html).toContain(pluralDeadline(RESPONSE_WINDOW_DAYS));
  });

  it('still sends to the student with the trainer in the subject', async () => {
    await htmlOf({ responseWindowDays: CHOSEN_WINDOW_DAYS });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({ to: TO, subject: '[Teufit] Rafael Silva pediu seu feedback' });
  });
});
