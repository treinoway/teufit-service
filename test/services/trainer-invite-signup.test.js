import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db.js', () => ({
  prisma: {
    trainerInvite: { findUnique: vi.fn(), updateMany: vi.fn() },
    user: { create: vi.fn() },
    account: { create: vi.fn() },
    pendingSignup: { deleteMany: vi.fn() },
    $queryRaw: vi.fn(),
    $transaction: vi.fn(),
  },
}));

vi.mock('../../src/services/user-service.js', () => ({ setActiveProfileToTrainer: vi.fn() }));
vi.mock('../../src/services/email-verification-service.js', () => ({ markEmailVerifiedFromInboxProof: vi.fn() }));
vi.mock('../../src/config/email-handler.js', () => ({
  default: { sendTrainerInviteEmail: vi.fn(), sendEmailVerificationEmail: vi.fn() },
}));
vi.mock('../../src/helpers/password.js', () => ({ hashPassword: vi.fn() }));

import { prisma } from '../../src/db.js';
import emailHandler from '../../src/config/email-handler.js';
import { hashPassword } from '../../src/helpers/password.js';
import { setActiveProfileToTrainer } from '../../src/services/user-service.js';
import { Roles } from '../../src/constants/roles.js';
import { EMAIL_PROVIDER } from '../../src/constants/email-verification.js';
import { InviteStatus, InviteErrorCode, InviteMessageCode } from '../../src/constants/trainer-invite.js';
import { signupWithInvite } from '../../src/services/trainer-invite-service.js';

const CODE = 'TF-ABCD-EFGH-12';
const PASSWORD = 'StrongPassw0rd!';
const PASSWORD_HASH = 'scrypt$hashed';
const INVITE_ID = 'invite-1';
const NEW_USER_ID = 'new-user-1';
const INVITE_EMAIL = 'Invitee@Example.com';
const NORMALIZED_EMAIL = 'invitee@example.com';
const HOUR_MS = 60 * 60 * 1000;

function baseInvite(overrides = {}) {
  return {
    id: INVITE_ID,
    email: INVITE_EMAIL,
    codeHash: 'hash',
    status: InviteStatus.PENDING,
    userId: null,
    expiresAt: new Date(Date.now() + HOUR_MS),
    ...overrides,
  };
}

function uniqueViolation() {
  return Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
}

describe('signupWithInvite', () => {
  beforeEach(() => {
    prisma.$transaction.mockImplementation(async (callback) => callback(prisma));
    prisma.trainerInvite.findUnique.mockResolvedValue(baseInvite());
    prisma.trainerInvite.updateMany.mockResolvedValue({ count: 1 });
    prisma.$queryRaw.mockResolvedValue([]);
    prisma.user.create.mockResolvedValue({ id: NEW_USER_ID, email: NORMALIZED_EMAIL, roles: [Roles.TRAINER] });
    prisma.account.create.mockResolvedValue({});
    setActiveProfileToTrainer.mockResolvedValue({ userId: NEW_USER_ID, activeProfile: 'trainer' });
    prisma.pendingSignup.deleteMany.mockResolvedValue({ count: 0 });
    hashPassword.mockReturnValue(PASSWORD_HASH);
  });

  describe('invite validation', () => {
    it('should throw a 400 validation error when the code is blank', async () => {
      await expect(signupWithInvite({ code: '  ', password: PASSWORD })).rejects.toMatchObject({
        httpStatus: 400,
        error: 'VALIDATION_ERROR',
      });
      expect(prisma.user.create).not.toHaveBeenCalled();
    });

    it('should throw 404 invite.notFound when no invite matches', async () => {
      prisma.trainerInvite.findUnique.mockResolvedValue(null);

      await expect(signupWithInvite({ code: CODE, password: PASSWORD })).rejects.toMatchObject({
        httpStatus: 404,
        error: InviteErrorCode.INVITE_NOT_FOUND,
        messageCode: InviteMessageCode.NOT_FOUND,
      });
      expect(prisma.user.create).not.toHaveBeenCalled();
    });

    it('should throw 403 invite.revoked for a revoked invite', async () => {
      prisma.trainerInvite.findUnique.mockResolvedValue(baseInvite({ status: InviteStatus.REVOKED }));

      await expect(signupWithInvite({ code: CODE, password: PASSWORD })).rejects.toMatchObject({
        httpStatus: 403,
        error: InviteErrorCode.INVITE_REVOKED,
        messageCode: InviteMessageCode.REVOKED,
      });
      expect(prisma.user.create).not.toHaveBeenCalled();
    });

    it('should throw 409 invite.alreadyAccepted for an accepted invite', async () => {
      prisma.trainerInvite.findUnique.mockResolvedValue(baseInvite({ status: InviteStatus.ACCEPTED, userId: 'someone' }));

      await expect(signupWithInvite({ code: CODE, password: PASSWORD })).rejects.toMatchObject({
        httpStatus: 409,
        error: InviteErrorCode.INVITE_ALREADY_ACCEPTED,
        messageCode: InviteMessageCode.ALREADY_ACCEPTED,
      });
      expect(prisma.user.create).not.toHaveBeenCalled();
    });

    it('should flip an expired pending invite to expired and throw 403 invite.expired', async () => {
      prisma.trainerInvite.findUnique.mockResolvedValue(baseInvite({ expiresAt: new Date(Date.now() - 1000) }));

      await expect(signupWithInvite({ code: CODE, password: PASSWORD })).rejects.toMatchObject({
        httpStatus: 403,
        error: InviteErrorCode.INVITE_EXPIRED,
        messageCode: InviteMessageCode.EXPIRED,
      });
      expect(prisma.trainerInvite.updateMany).toHaveBeenCalledWith({
        where: { id: INVITE_ID, status: InviteStatus.PENDING },
        data: { status: InviteStatus.EXPIRED },
      });
      expect(prisma.user.create).not.toHaveBeenCalled();
    });

    it('should not hash the password when the invite is rejected', async () => {
      prisma.trainerInvite.findUnique.mockResolvedValue(null);

      await expect(signupWithInvite({ code: CODE, password: PASSWORD })).rejects.toBeDefined();
      expect(hashPassword).not.toHaveBeenCalled();
    });
  });

  describe('existing account', () => {
    it('should throw 409 invite accountExists when a user already has the invite email', async () => {
      prisma.$queryRaw.mockResolvedValue([{ id: 'existing-user' }]);

      await expect(signupWithInvite({ code: CODE, password: PASSWORD })).rejects.toMatchObject({
        httpStatus: 409,
        error: InviteErrorCode.INVITE_ACCOUNT_EXISTS,
        messageCode: InviteMessageCode.ACCOUNT_EXISTS,
      });
    });

    it('should create nothing, claim nothing and skip hashing when the account exists', async () => {
      prisma.$queryRaw.mockResolvedValue([{ id: 'existing-user' }]);

      await expect(signupWithInvite({ code: CODE, password: PASSWORD })).rejects.toBeDefined();

      expect(hashPassword).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.user.create).not.toHaveBeenCalled();
      expect(prisma.trainerInvite.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('happy path', () => {
    it('should return the created user and trainer preferences', async () => {
      const result = await signupWithInvite({ code: CODE, password: PASSWORD });

      expect(result.user.id).toBe(NEW_USER_ID);
      expect(result.preferences).toEqual({ userId: NEW_USER_ID, activeProfile: 'trainer' });
    });

    it('should create an active trainer user with the normalized email and hashed password', async () => {
      await signupWithInvite({ code: CODE, password: PASSWORD });

      expect(hashPassword).toHaveBeenCalledWith(PASSWORD);
      expect(prisma.user.create).toHaveBeenCalledWith({
        data: { email: NORMALIZED_EMAIL, passwordHash: PASSWORD_HASH, roles: [Roles.TRAINER], status: 'active' },
      });
    });

    it('should create an email account that is already verified', async () => {
      await signupWithInvite({ code: CODE, password: PASSWORD });

      expect(prisma.account.create).toHaveBeenCalledWith({
        data: {
          userId: NEW_USER_ID,
          provider: EMAIL_PROVIDER,
          providerId: NORMALIZED_EMAIL,
          verifiedAt: expect.any(Date),
        },
      });
    });

    it('should claim the invite with a conditional pending-and-unexpired to accepted update', async () => {
      await signupWithInvite({ code: CODE, password: PASSWORD });

      expect(prisma.trainerInvite.updateMany).toHaveBeenCalledWith({
        where: { id: INVITE_ID, status: InviteStatus.PENDING, expiresAt: { gt: expect.any(Date) } },
        data: { status: InviteStatus.ACCEPTED, userId: NEW_USER_ID, acceptedAt: expect.any(Date) },
      });
    });

    it('should grant the trainer profile through setActiveProfileToTrainer on the transaction client', async () => {
      // $transaction is mocked to hand the callback `prisma` as the tx client.
      await signupWithInvite({ code: CODE, password: PASSWORD });

      expect(setActiveProfileToTrainer).toHaveBeenCalledTimes(1);
      expect(setActiveProfileToTrainer).toHaveBeenCalledWith(NEW_USER_ID, { tx: prisma });
    });

    it('should delete the pending signup for the normalized email', async () => {
      await signupWithInvite({ code: CODE, password: PASSWORD });

      expect(prisma.pendingSignup.deleteMany).toHaveBeenCalledWith({ where: { email: NORMALIZED_EMAIL } });
    });

    it('should run everything inside a single transaction', async () => {
      await signupWithInvite({ code: CODE, password: PASSWORD });

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it('should not send any verification email', async () => {
      await signupWithInvite({ code: CODE, password: PASSWORD });

      expect(emailHandler.sendEmailVerificationEmail).not.toHaveBeenCalled();
    });
  });

  describe('lost claim inside the transaction', () => {
    function mockLostClaim(currentState) {
      prisma.trainerInvite.findUnique
        .mockResolvedValueOnce(baseInvite()) // initial lookup
        .mockResolvedValueOnce(currentState); // resolveLostClaimError re-read (tx client)
      prisma.trainerInvite.updateMany.mockResolvedValueOnce({ count: 0 });
    }

    it('should throw 403 invite.revoked when the invite was revoked during the claim', async () => {
      mockLostClaim({ status: InviteStatus.REVOKED, expiresAt: new Date(Date.now() + HOUR_MS) });

      await expect(signupWithInvite({ code: CODE, password: PASSWORD })).rejects.toMatchObject({
        httpStatus: 403,
        error: InviteErrorCode.INVITE_REVOKED,
        messageCode: InviteMessageCode.REVOKED,
      });
      expect(setActiveProfileToTrainer).not.toHaveBeenCalled();
    });

    it('should throw 409 invite.alreadyAccepted when the invite was accepted during the claim', async () => {
      mockLostClaim({ status: InviteStatus.ACCEPTED, expiresAt: new Date(Date.now() + HOUR_MS) });

      await expect(signupWithInvite({ code: CODE, password: PASSWORD })).rejects.toMatchObject({
        httpStatus: 409,
        messageCode: InviteMessageCode.ALREADY_ACCEPTED,
      });
    });

    it('should throw 404 invite.notFound when the invite vanished during the claim', async () => {
      mockLostClaim(null);

      await expect(signupWithInvite({ code: CODE, password: PASSWORD })).rejects.toMatchObject({
        httpStatus: 404,
        error: InviteErrorCode.INVITE_NOT_FOUND,
        messageCode: InviteMessageCode.NOT_FOUND,
      });
    });

    it('should throw 403 invite.expired and flip the row to expired outside the transaction when pending past expiry', async () => {
      mockLostClaim({ status: InviteStatus.PENDING, expiresAt: new Date(Date.now() - 1000) });

      await expect(signupWithInvite({ code: CODE, password: PASSWORD })).rejects.toMatchObject({
        httpStatus: 403,
        error: InviteErrorCode.INVITE_EXPIRED,
        messageCode: InviteMessageCode.EXPIRED,
      });

      expect(prisma.trainerInvite.updateMany).toHaveBeenCalledTimes(2);
      expect(prisma.trainerInvite.updateMany).toHaveBeenLastCalledWith({
        where: { id: INVITE_ID, status: InviteStatus.PENDING },
        data: { status: InviteStatus.EXPIRED },
      });
      expect(setActiveProfileToTrainer).not.toHaveBeenCalled();
    });

    it('should throw 403 invite.expired and still attempt the flip when the row is already expired', async () => {
      mockLostClaim({ status: InviteStatus.EXPIRED, expiresAt: new Date(Date.now() - 1000) });

      await expect(signupWithInvite({ code: CODE, password: PASSWORD })).rejects.toMatchObject({
        httpStatus: 403,
        messageCode: InviteMessageCode.EXPIRED,
      });
      expect(prisma.trainerInvite.updateMany).toHaveBeenCalledTimes(2);
    });

    it('should fall back to 409 alreadyAccepted without flipping when pending and not expired', async () => {
      mockLostClaim({ status: InviteStatus.PENDING, expiresAt: new Date(Date.now() + HOUR_MS) });

      await expect(signupWithInvite({ code: CODE, password: PASSWORD })).rejects.toMatchObject({
        httpStatus: 409,
        messageCode: InviteMessageCode.ALREADY_ACCEPTED,
      });
      expect(prisma.trainerInvite.updateMany).toHaveBeenCalledTimes(1);
    });
  });

  describe('transaction failures', () => {
    it('should throw 409 invite.alreadyAccepted when the claim finds the invite no longer pending', async () => {
      // The claim inside the transaction loses the race.
      prisma.trainerInvite.updateMany.mockResolvedValue({ count: 0 });

      await expect(signupWithInvite({ code: CODE, password: PASSWORD })).rejects.toMatchObject({
        httpStatus: 409,
        error: InviteErrorCode.INVITE_ALREADY_ACCEPTED,
        messageCode: InviteMessageCode.ALREADY_ACCEPTED,
      });
    });

    it('should not create the trainer row or clean pending signups when the claim fails', async () => {
      prisma.trainerInvite.updateMany.mockResolvedValue({ count: 0 });

      await expect(signupWithInvite({ code: CODE, password: PASSWORD })).rejects.toBeDefined();

      expect(setActiveProfileToTrainer).not.toHaveBeenCalled();
      expect(prisma.pendingSignup.deleteMany).not.toHaveBeenCalled();
    });

    it('should map a P2002 on user create to alreadyAccepted when the invite is no longer pending', async () => {
      prisma.user.create.mockRejectedValue(uniqueViolation());
      // Second findUnique (after the failure) sees the winner's accepted invite.
      prisma.trainerInvite.findUnique
        .mockResolvedValueOnce(baseInvite())
        .mockResolvedValueOnce({ status: InviteStatus.ACCEPTED });

      await expect(signupWithInvite({ code: CODE, password: PASSWORD })).rejects.toMatchObject({
        httpStatus: 409,
        error: InviteErrorCode.INVITE_ALREADY_ACCEPTED,
        messageCode: InviteMessageCode.ALREADY_ACCEPTED,
      });
    });

    it('should map a P2002 on user create to accountExists when the invite is still pending', async () => {
      prisma.user.create.mockRejectedValue(uniqueViolation());
      prisma.trainerInvite.findUnique
        .mockResolvedValueOnce(baseInvite())
        .mockResolvedValueOnce({ status: InviteStatus.PENDING });

      await expect(signupWithInvite({ code: CODE, password: PASSWORD })).rejects.toMatchObject({
        httpStatus: 409,
        error: InviteErrorCode.INVITE_ACCOUNT_EXISTS,
        messageCode: InviteMessageCode.ACCOUNT_EXISTS,
      });
    });

    it('should rethrow non-unique database errors untouched', async () => {
      const dbError = new Error('connection lost');
      prisma.user.create.mockRejectedValue(dbError);

      await expect(signupWithInvite({ code: CODE, password: PASSWORD })).rejects.toBe(dbError);
    });

    it('should resolve a P2002 raised by a later transaction step the same way', async () => {
      setActiveProfileToTrainer.mockRejectedValue(uniqueViolation());
      prisma.trainerInvite.findUnique
        .mockResolvedValueOnce(baseInvite())
        .mockResolvedValueOnce({ status: InviteStatus.PENDING });

      await expect(signupWithInvite({ code: CODE, password: PASSWORD })).rejects.toMatchObject({
        error: InviteErrorCode.INVITE_ACCOUNT_EXISTS,
      });
    });
  });
});
