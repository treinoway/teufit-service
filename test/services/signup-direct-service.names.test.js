import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/config/email-handler.js', () => ({ default: { sendEmailVerificationEmail: vi.fn() } }));
vi.mock('../../src/services/student-invite-service.js', () => ({ acceptPendingInvitesForUser: vi.fn() }));
vi.mock('../../src/services/email-verification-service.js', async (importOriginal) => ({
  ...(await importOriginal()),
  sendVerificationCodeSafely: vi.fn(),
}));

import { sendVerificationCodeSafely } from '../../src/services/email-verification-service.js';
import { signupDirect } from '../../src/services/signup-verification-service.js';
import { UserStatus } from '../../src/constants/user-status.js';

const EMAIL = 'new.trainer@example.com';
const PASSWORD = 'correct horse battery';
const USER_ID = 'user-1';

// Prisma double that records the user row signupDirect creates.
function makePrisma() {
  const prisma = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    user: { create: vi.fn(async ({ data }) => ({ id: USER_ID, ...data })) },
    account: { create: vi.fn().mockResolvedValue({}) },
  };
  prisma.$transaction = vi.fn(async (work) => work(prisma));
  return prisma;
}

describe('signupDirect stored names, status and code delivery', () => {
  let prisma;
  const emailSender = { sendEmailVerificationEmail: vi.fn() };
  const createdUser = () => prisma.user.create.mock.calls[0][0].data;

  beforeEach(() => {
    vi.clearAllMocks();
    prisma = makePrisma();
  });

  it('should trim firstName and lastName', async () => {
    await signupDirect(prisma, { email: EMAIL, password: PASSWORD, firstName: '  Bia ', lastName: ' Souza  ' }, { emailSender });

    expect(createdUser()).toMatchObject({ firstName: 'Bia', lastName: 'Souza' });
  });

  it.each([
    ['an empty string', ''],
    ['only spaces', '   '],
    ['undefined', undefined],
  ])('should store lastName as null when it is %s', async (_label, lastName) => {
    await signupDirect(prisma, { email: EMAIL, password: PASSWORD, firstName: 'Bia', lastName }, { emailSender });

    expect(createdUser().lastName).toBeNull();
  });

  it('should create the user as pending, like legacy unverified accounts', async () => {
    await signupDirect(prisma, { email: EMAIL, password: PASSWORD, firstName: 'Bia' }, { emailSender });

    expect(createdUser().status).toBe(UserStatus.PENDING);
  });

  it('should hand the new user and the normalized email to the shared verification-code path', async () => {
    await signupDirect(prisma, { email: ' New.Trainer@Example.COM ', password: PASSWORD, firstName: 'Bia' }, { emailSender });

    expect(sendVerificationCodeSafely).toHaveBeenCalledTimes(1);
    expect(sendVerificationCodeSafely).toHaveBeenCalledWith(prisma, { userId: USER_ID, email: EMAIL }, { emailSender });
  });
});
