import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from 'vitest';
import { prisma } from '../../src/db.js';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { provisionTrainerPlan } from '../helpers/platform-plan.js';
import { seedLegacyUnverifiedUser } from '../helpers/legacy-user.js';
import { signupVerified } from '../helpers/signup-user.js';
import { expectErrorContract } from '../helpers/nutrition-e2e.js';
import emailHandler from '../../src/config/email-handler.js';
import { PLATFORM_PLAN_TIERS } from '../../src/constants/platform-plan.js';
import { StudentInviteOutcome } from '../../src/constants/student-invite.js';
import ptBR from '../../src/i18n/locales/pt-BR.js';
import enUS from '../../src/i18n/locales/en-US.js';

const anthropicCreate = vi.fn();
const anthropicStream = vi.fn();

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn(),
}));

import Anthropic from '@anthropic-ai/sdk';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

const PASSWORD = 'StrongPassw0rd!';
const AI_CHAT_URL = '/trainer/ai/chat';
const AI_CHAT_STREAM_URL = '/trainer/ai/chat/stream';
const STUDENT_INVITES_URL = '/trainer/student-invites';
const PATIENT_INVITES_URL = '/nutritionist/patient-invites';
const UNVERIFIED_SENDER_INVITE_CAP = 3;
const EMAIL_VERIFICATION_REQUIRED = Object.freeze({
  statusCode: 403,
  error: 'EMAIL_VERIFICATION_REQUIRED',
  messageCode: 'emailVerification.required',
});
const Language = Object.freeze({ PT: 'pt-BR', EN: 'en-US' });

e2eDescribe('e2e: actions that require a verified email (emailVerification.required)', () => {
  let app;
  let verificationCodes;
  let emailCounter = 0;

  const uniqueEmail = (prefix) => {
    emailCounter += 1;
    return `e2e+${prefix}-${Date.now()}-${emailCounter}@example.com`;
  };
  const auth = (token) => ({ authorization: `Bearer ${token}` });
  const post = (url, token, payload, headers = {}) =>
    app.inject({ method: 'POST', url, headers: { ...auth(token), ...headers }, payload });
  const aiChat = (token, headers) => post(AI_CHAT_URL, token, { message: 'Olá' }, headers);
  const inviteStudent = (token) => post(STUDENT_INVITES_URL, token, { email: uniqueEmail('student') });
  const invitePatient = (token) => post(PATIENT_INVITES_URL, token, { email: uniqueEmail('patient') });

  async function sendInvites(send, token, count) {
    const responses = [];
    for (let sent = 0; sent < count; sent += 1) responses.push(await send(token));
    return responses;
  }

  async function createAccount({ verified }) {
    const email = uniqueEmail(verified ? 'verified' : 'unverified');
    if (!verified) return seedLegacyUnverifiedUser(app, { email, password: PASSWORD });
    const res = await signupVerified(app, { payload: { email, password: PASSWORD } });
    expect(res.statusCode).toBe(201);
    return { email, userId: res.json().user.id, accessToken: res.json().token.accessToken };
  }

  async function createTrainer({ verified }) {
    const account = await createAccount({ verified });
    const res = await app.inject({ method: 'PATCH', url: '/become-trainer', headers: auth(account.accessToken) });
    expect(res.statusCode).toBe(200);
    const trainer = await prisma.trainer.findUnique({ where: { userId: account.userId }, select: { id: true } });
    await provisionTrainerPlan(trainer.id, PLATFORM_PLAN_TIERS.BETA);
    return { ...account, trainerId: trainer.id, accessToken: res.json().token.accessToken };
  }

  async function createNutritionist({ verified }) {
    const account = await createAccount({ verified });
    const res = await app.inject({ method: 'PATCH', url: '/become-nutritionist', headers: auth(account.accessToken) });
    expect(res.statusCode).toBe(200);
    const nutritionist = await prisma.nutritionist.findUnique({ where: { userId: account.userId }, select: { id: true } });
    return { ...account, nutritionistId: nutritionist.id, accessToken: res.json().token.accessToken };
  }

  async function verifyEmailOf(professional) {
    const res = await post('/auth/verify-email', professional.accessToken, { code: verificationCodes.get(professional.email) });
    expect(res.statusCode).toBe(200);
  }

  beforeAll(async () => {
    app = await setupApp();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(async () => {
    await cleanDatabase();
    verificationCodes = new Map();
    Anthropic.mockImplementation(function () {
      this.messages = { create: anthropicCreate, stream: anthropicStream };
    });
    anthropicCreate.mockResolvedValue({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Olá! Como posso ajudar?' }] });
    vi.spyOn(emailHandler, 'sendEmailVerificationEmail').mockImplementation(async ({ to, code }) => {
      verificationCodes.set(to.toLowerCase(), code);
      return { data: { id: 'email-id' } };
    });
    vi.spyOn(emailHandler, 'sendTrainerWelcomeEmail').mockResolvedValue({ data: { id: 'email-id' } });
    vi.spyOn(emailHandler, 'sendStudentInviteEmail').mockResolvedValue({ data: { id: 'email-id' } });
    vi.spyOn(emailHandler, 'sendPatientInviteEmail').mockResolvedValue({ data: { id: 'email-id' } });
  });

  describe('AI actions', () => {
    describe('for a trainer whose email is unverified', () => {
      let trainer;

      beforeEach(async () => {
        trainer = await createTrainer({ verified: false });
      });

      it('should answer 403 EMAIL_VERIFICATION_REQUIRED on POST /trainer/ai/chat', async () => {
        const res = await aiChat(trainer.accessToken);

        expectErrorContract(res, EMAIL_VERIFICATION_REQUIRED);
      });

      it('should answer a JSON 403 EMAIL_VERIFICATION_REQUIRED on POST /trainer/ai/chat/stream', async () => {
        const res = await post(AI_CHAT_STREAM_URL, trainer.accessToken, { message: 'Olá' });

        expectErrorContract(res, EMAIL_VERIFICATION_REQUIRED);
      });

      it('should not call the model', async () => {
        await aiChat(trainer.accessToken);

        expect(anthropicCreate).not.toHaveBeenCalled();
        expect(anthropicStream).not.toHaveBeenCalled();
      });

      it('should create no conversation and record no AI usage', async () => {
        await aiChat(trainer.accessToken);

        expect(await prisma.aiConversation.count({ where: { userId: trainer.userId } })).toBe(0);
        expect(await prisma.aiUsageEvent.count({ where: { trainerId: trainer.trainerId } })).toBe(0);
      });

      it.each([
        [Language.PT, ptBR],
        [Language.EN, enUS],
      ])('should translate the message to %s', async (language, locale) => {
        const res = await aiChat(trainer.accessToken, { 'app-language': language });

        const body = expectErrorContract(res, EMAIL_VERIFICATION_REQUIRED);
        expect(locale.errors[EMAIL_VERIFICATION_REQUIRED.messageCode]).toEqual(expect.any(String));
        expect(body.message).toBe(locale.errors[EMAIL_VERIFICATION_REQUIRED.messageCode]);
      });

      it('should answer 200 once the email is verified with the code', async () => {
        await verifyEmailOf(trainer);

        const res = await aiChat(trainer.accessToken);

        expect(res.statusCode).toBe(200);
      });
    });

    it('should answer 200 for a trainer whose email is verified', async () => {
      const trainer = await createTrainer({ verified: true });

      const res = await aiChat(trainer.accessToken);

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ conversationId: expect.any(String), message: expect.any(String) });
    });
  });

  describe.each([
    {
      name: 'student invites (POST /trainer/student-invites)',
      createSender: (options) => createTrainer(options),
      send: (token) => inviteStudent(token),
      countInvites: (sender) => prisma.studentInvite.count({ where: { trainerId: sender.trainerId } }),
      emailSpy: 'sendStudentInviteEmail',
    },
    {
      name: 'patient invites (POST /nutritionist/patient-invites)',
      createSender: (options) => createNutritionist(options),
      send: (token) => invitePatient(token),
      countInvites: (sender) => prisma.patientInvite.count({ where: { nutritionistId: sender.nutritionistId } }),
      emailSpy: 'sendPatientInviteEmail',
    },
  ])('$name', (surface) => {
    describe('for a professional whose email is unverified', () => {
      let sender;
      let firstResponses;

      beforeEach(async () => {
        sender = await surface.createSender({ verified: false });
        firstResponses = await sendInvites(surface.send, sender.accessToken, UNVERIFIED_SENDER_INVITE_CAP);
      });

      it('should accept the first three invites', async () => {
        expect(firstResponses.map((res) => res.statusCode)).toEqual(Array(UNVERIFIED_SENDER_INVITE_CAP).fill(201));
        expect(firstResponses.map((res) => res.json().outcome)).toEqual(
          Array(UNVERIFIED_SENDER_INVITE_CAP).fill(StudentInviteOutcome.INVITED),
        );
      });

      it('should reject the fourth invite within 24 hours with 403 EMAIL_VERIFICATION_REQUIRED', async () => {
        const res = await surface.send(sender.accessToken);

        expectErrorContract(res, EMAIL_VERIFICATION_REQUIRED);
      });

      it('should create no invite and send no email for the rejected one', async () => {
        await surface.send(sender.accessToken);

        expect(await surface.countInvites(sender)).toBe(UNVERIFIED_SENDER_INVITE_CAP);
        expect(emailHandler[surface.emailSpy]).toHaveBeenCalledTimes(UNVERIFIED_SENDER_INVITE_CAP);
      });

      it('should accept the fourth invite once the email is verified with the code', async () => {
        await verifyEmailOf(sender);

        const res = await surface.send(sender.accessToken);

        expect(res.statusCode).toBe(201);
        expect(await surface.countInvites(sender)).toBe(UNVERIFIED_SENDER_INVITE_CAP + 1);
      });
    });

    it('should accept a fourth invite within 24 hours from a professional whose email is verified', async () => {
      const sender = await surface.createSender({ verified: true });

      const responses = await sendInvites(surface.send, sender.accessToken, UNVERIFIED_SENDER_INVITE_CAP + 1);

      expect(responses.map((res) => res.statusCode)).toEqual(Array(UNVERIFIED_SENDER_INVITE_CAP + 1).fill(201));
    });
  });

  it('should keep the student and patient caps separate for a professional with both roles', async () => {
    const trainer = await createTrainer({ verified: false });
    const both = await app.inject({ method: 'PATCH', url: '/become-nutritionist', headers: auth(trainer.accessToken) });
    expect(both.statusCode).toBe(200);
    const token = both.json().token.accessToken;
    await sendInvites(inviteStudent, token, UNVERIFIED_SENDER_INVITE_CAP);

    const res = await invitePatient(token);

    expect(res.statusCode).toBe(201);
  });
});
