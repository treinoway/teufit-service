import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/config/email-handler.js', () => ({
  default: { sendEmailVerificationEmail: vi.fn(), sendExistingAccountSignupEmail: vi.fn() },
}));
vi.mock('../../src/services/student-invite-service.js', () => ({
  acceptPendingInvitesForUser: vi.fn(),
}));

import { acceptPendingInvitesForUser } from '../../src/services/student-invite-service.js';
import { EMAIL_PROVIDER, EMAIL_VERIFICATION_CODE_LENGTH } from '../../src/constants/email-verification.js';
import { verifyPassword } from '../../src/helpers/password.js';
import { signupDirect } from '../../src/services/signup-verification-service.js';

const EMAIL = 'new.trainer@example.com';
const MIXED_CASE_EMAIL = '  New.Trainer@Example.COM ';
const STORED_MIXED_CASE_EMAIL = 'New.Trainer@Example.com';
const PASSWORD = 'correct horse battery';
const FIRST_NAME = 'Bia';
const LAST_NAME = 'Souza';
const SIGNUP_SOURCE_WEB_DIRECT = 'web_direct';
const EMAIL_IN_USE = 'EMAIL_IN_USE';
const CONFLICT_STATUS = 409;
const UNIQUE_VIOLATION_CODE = 'P2002';
const CODE_PATTERN = new RegExp(`^[0-9]{${EMAIL_VERIFICATION_CODE_LENGTH}}$`);

// Builds the error Prisma raises on a unique constraint violation.
function uniqueViolation() {
  return Object.assign(new Error('Unique constraint failed'), { code: UNIQUE_VIOLATION_CODE });
}

// Normalizes an email the way the users_email_lower_idx lookup does.
function lower(email) {
  return String(email ?? '').trim().toLowerCase();
}

// In-memory Prisma stand-in for signup: rows are really stored, so tests assert outcomes instead of query shapes.
function createSignupWorld({ users = [] } = {}) {
  const state = { users: users.map((user) => ({ ...user })), accounts: [], tokens: [], openTransactions: 0 };
  let sequence = 0;
  const nextId = (prefix) => {
    sequence += 1;
    return `${prefix}-${sequence}`;
  };

  const insertAccount = (data) => {
    const row = { id: nextId('account'), verifiedAt: null, ...data };
    state.accounts.push(row);
    return row;
  };

  const insertUser = ({ accounts, ...data }) => {
    if (state.users.some((user) => lower(user.email) === lower(data.email))) throw uniqueViolation();
    const row = { id: nextId('user'), deletedAt: null, firstName: null, lastName: null, signupSource: null, ...data };
    state.users.push(row);
    for (const account of [accounts?.create ?? []].flat()) insertAccount({ ...account, userId: row.id });
    return row;
  };

  const findUser = ({ where }) =>
    state.users.find((user) => (where.id ? user.id === where.id : user.email === where.email)) ?? null;

  const prisma = {
    $queryRaw: vi.fn(async (_strings, email) =>
      state.users.filter((user) => lower(user.email) === lower(email)).map((user) => ({ id: user.id })),
    ),
    user: {
      create: vi.fn(async ({ data }) => insertUser(data)),
      findUnique: vi.fn(async (args) => findUser(args)),
      findFirst: vi.fn(async (args) => findUser(args)),
    },
    account: {
      create: vi.fn(async ({ data }) => insertAccount(data)),
      findFirst: vi.fn(async ({ where }) => state.accounts.find((account) => account.userId === where.userId) ?? null),
    },
    emailVerificationToken: {
      findMany: vi.fn(async ({ where }) => state.tokens.filter((token) => token.userId === where.userId)),
      findFirst: vi.fn(async ({ where }) => state.tokens.find((token) => token.userId === where.userId) ?? null),
      create: vi.fn(async ({ data }) => {
        const row = { id: nextId('token'), createdAt: new Date(), used: false, sendFailedAt: null, ...data };
        state.tokens.push(row);
        return row;
      }),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
  };

  prisma.$transaction = vi.fn(async (work) => {
    if (typeof work !== 'function') return Promise.all(work);
    state.openTransactions += 1;
    try {
      return await work(prisma);
    } finally {
      state.openTransactions -= 1;
    }
  });

  return { prisma, state };
}

// Email sender double that records what the database looked like when the code email was sent.
function createEmailSender(state) {
  const snapshots = [];
  const sendEmailVerificationEmail = vi.fn(async () => {
    snapshots.push({ users: state.users.length, accounts: state.accounts.length, openTransactions: state.openTransactions });
    return { data: { id: 'message-1' } };
  });
  return { emailSender: { sendEmailVerificationEmail }, snapshots };
}

// Waits until the verification code email was handed to the sender exactly once.
async function waitForCodeEmail(emailSender) {
  await vi.waitFor(() => expect(emailSender.sendEmailVerificationEmail).toHaveBeenCalledTimes(1));
  return emailSender.sendEmailVerificationEmail.mock.calls[0][0];
}

describe('signupDirect (POST /auth/signup/direct)', () => {
  let prisma;
  let state;
  let emailSender;
  let snapshots;

  const input = (overrides = {}) => ({
    email: EMAIL,
    password: PASSWORD,
    firstName: FIRST_NAME,
    lastName: LAST_NAME,
    ...overrides,
  });

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    ({ prisma, state } = createSignupWorld());
    ({ emailSender, snapshots } = createEmailSender(state));
    acceptPendingInvitesForUser.mockResolvedValue(0);
  });

  describe('when the email has no account', () => {
    it('should create exactly one user', async () => {
      await signupDirect(prisma, input(), { emailSender });

      expect(state.users).toHaveLength(1);
    });

    it('should store the email trimmed and lowercased', async () => {
      await signupDirect(prisma, input({ email: MIXED_CASE_EMAIL }), { emailSender });

      expect(state.users[0].email).toBe(EMAIL);
    });

    it('should create the user with no roles (no profession is chosen at signup)', async () => {
      await signupDirect(prisma, input(), { emailSender });

      expect(state.users[0].roles).toEqual([]);
    });

    it('should store firstName and lastName', async () => {
      await signupDirect(prisma, input(), { emailSender });

      expect(state.users[0]).toMatchObject({ firstName: FIRST_NAME, lastName: LAST_NAME });
    });

    it('should accept a signup without lastName and leave it empty', async () => {
      await signupDirect(prisma, input({ lastName: undefined }), { emailSender });

      expect(state.users[0].firstName).toBe(FIRST_NAME);
      expect(state.users[0].lastName ?? null).toBeNull();
    });

    it('should store the password hashed, never in plain text', async () => {
      await signupDirect(prisma, input(), { emailSender });

      const { passwordHash } = state.users[0];
      expect(passwordHash).not.toBe(PASSWORD);
      expect(verifyPassword(PASSWORD, passwordHash)).toBe(true);
    });

    it('should record signupSource web_direct on the user', async () => {
      await signupDirect(prisma, input(), { emailSender });

      expect(state.users[0].signupSource).toBe(SIGNUP_SOURCE_WEB_DIRECT);
    });

    it('should create one email Account for the normalized email', async () => {
      await signupDirect(prisma, input({ email: MIXED_CASE_EMAIL }), { emailSender });

      expect(state.accounts).toHaveLength(1);
      expect(state.accounts[0]).toMatchObject({ userId: state.users[0].id, provider: EMAIL_PROVIDER, providerId: EMAIL });
    });

    it('should leave the email Account unverified', async () => {
      await signupDirect(prisma, input(), { emailSender });

      expect(state.accounts[0].verifiedAt ?? null).toBeNull();
    });

    it('should return the created user and zero linked trainers', async () => {
      const result = await signupDirect(prisma, input(), { emailSender });

      expect(result.user).toMatchObject({ id: state.users[0].id, email: EMAIL, roles: [] });
      expect(result.linkedTrainers).toBe(0);
    });

    it('should not accept pending student invites, which are bound to a verified email', async () => {
      await signupDirect(prisma, input(), { emailSender });

      expect(acceptPendingInvitesForUser).not.toHaveBeenCalled();
    });
  });

  describe('verification code email', () => {
    it('should email a numeric verification code to the normalized email', async () => {
      await signupDirect(prisma, input({ email: MIXED_CASE_EMAIL }), { emailSender });

      const sent = await waitForCodeEmail(emailSender);
      expect(sent.to).toBe(EMAIL);
      expect(sent.code).toMatch(CODE_PATTERN);
    });

    it('should store the emailed code hashed for the new user', async () => {
      await signupDirect(prisma, input(), { emailSender });

      const sent = await waitForCodeEmail(emailSender);
      expect(state.tokens).toHaveLength(1);
      expect(state.tokens[0].userId).toBe(state.users[0].id);
      expect(state.tokens[0].tokenHash).not.toBe(sent.code);
    });

    it('should send the email only after the user and the account are committed', async () => {
      await signupDirect(prisma, input(), { emailSender });

      await waitForCodeEmail(emailSender);
      expect(snapshots[0]).toEqual({ users: 1, accounts: 1, openTransactions: 0 });
    });

    it('should not fail the signup when the email provider throws', async () => {
      emailSender.sendEmailVerificationEmail.mockRejectedValue(new Error('provider down'));

      const result = await signupDirect(prisma, input(), { emailSender });

      expect(result.user.id).toBe(state.users[0].id);
    });

    it('should not fail the signup when the email provider answers with an error object', async () => {
      emailSender.sendEmailVerificationEmail.mockResolvedValue({ error: { name: 'rate_limit_exceeded' } });

      const result = await signupDirect(prisma, input(), { emailSender });

      expect(result.user.id).toBe(state.users[0].id);
    });
  });

  describe('when the email already has an account', () => {
    const OWNER = Object.freeze({ id: 'owner-1', email: STORED_MIXED_CASE_EMAIL, deletedAt: null, roles: [] });

    beforeEach(() => {
      ({ prisma, state } = createSignupWorld({ users: [OWNER] }));
      ({ emailSender, snapshots } = createEmailSender(state));
    });

    it('should reject with 409 EMAIL_IN_USE', async () => {
      await expect(signupDirect(prisma, input(), { emailSender })).rejects.toMatchObject({
        name: 'AppError',
        httpStatus: CONFLICT_STATUS,
        error: EMAIL_IN_USE,
      });
    });

    it('should carry a messageCode so clients can translate the conflict', async () => {
      const rejection = await signupDirect(prisma, input(), { emailSender }).catch((error) => error);

      expect(rejection.messageCode).toEqual(expect.any(String));
      expect(rejection.messageCode.length).toBeGreaterThan(0);
    });

    it('should match the existing account case-insensitively', async () => {
      await expect(signupDirect(prisma, input({ email: MIXED_CASE_EMAIL }), { emailSender })).rejects.toMatchObject({
        httpStatus: CONFLICT_STATUS,
        error: EMAIL_IN_USE,
      });
    });

    it('should create no user', async () => {
      await signupDirect(prisma, input(), { emailSender }).catch(() => {});

      expect(state.users).toEqual([OWNER]);
    });

    it('should create no account', async () => {
      await signupDirect(prisma, input(), { emailSender }).catch(() => {});

      expect(state.accounts).toEqual([]);
    });

    it('should issue no verification code and send no email', async () => {
      await signupDirect(prisma, input(), { emailSender }).catch(() => {});

      expect(state.tokens).toEqual([]);
      expect(emailSender.sendEmailVerificationEmail).not.toHaveBeenCalled();
    });

    it('should also reject when the owner account is soft-deleted', async () => {
      state.users[0].deletedAt = new Date('2026-01-01T00:00:00.000Z');

      await expect(signupDirect(prisma, input(), { emailSender })).rejects.toMatchObject({
        httpStatus: CONFLICT_STATUS,
        error: EMAIL_IN_USE,
      });
    });
  });

  describe('when a concurrent signup takes the email between the lookup and the insert', () => {
    beforeEach(() => {
      prisma.user.create.mockRejectedValue(uniqueViolation());
    });

    it('should reject with 409 EMAIL_IN_USE instead of a 500', async () => {
      await expect(signupDirect(prisma, input(), { emailSender })).rejects.toMatchObject({
        httpStatus: CONFLICT_STATUS,
        error: EMAIL_IN_USE,
      });
    });

    it('should send no email', async () => {
      await signupDirect(prisma, input(), { emailSender }).catch(() => {});

      expect(emailSender.sendEmailVerificationEmail).not.toHaveBeenCalled();
    });
  });
});
