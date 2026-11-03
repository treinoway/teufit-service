import { prisma } from '../../src/db.js';
import { Roles } from '../../src/constants/roles.js';
import { signupVerified } from './signup-user.js';

const PASSWORD = 'StrongPassw0rd!';

let sequence = 0;

/** Unique email per call so parallel signups inside one test never collide. */
function uniqueEmail(prefix) {
  sequence += 1;
  return `e2e+${prefix}-${Date.now()}-${sequence}@example.com`;
}

/** Signs up a verified user and returns { userId, accessToken, email }. */
async function signupUser(app, prefix, extraPayload = {}) {
  const email = uniqueEmail(prefix);
  const response = await signupVerified(app, {
    method: 'POST',
    url: '/auth/signup',
    payload: { email, password: PASSWORD, ...extraPayload },
  });
  if (response.statusCode !== 201) {
    throw new Error(`signup failed for ${email}: ${response.statusCode} ${response.body}`);
  }
  const { user: { id: userId }, token: { accessToken } } = response.json();
  return { userId, accessToken, email };
}

/** Creates an admin user and returns { userId, accessToken }. */
export async function createAdminWithToken(app) {
  const { userId, email } = await signupUser(app, 'admin');
  const updatedUser = await prisma.user.update({
    where: { id: userId },
    data: { roles: [Roles.ADMIN] },
  });
  const accessToken = app.jwt.sign({
    sub: updatedUser.id,
    email,
    roles: [Roles.ADMIN],
    status: updatedUser.status,
  });
  return { userId, accessToken };
}

/** Creates a trainer and returns { userId, trainerId, accessToken, email }. */
export async function createTrainerWithToken(app, { firstName, lastName } = {}) {
  const { userId, accessToken, email } = await signupUser(app, 'trainer');
  const becomeTrainerResponse = await app.inject({
    method: 'PATCH',
    url: '/become-trainer',
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (becomeTrainerResponse.statusCode !== 200) {
    throw new Error(`become-trainer failed: ${becomeTrainerResponse.statusCode}`);
  }
  const { token: { accessToken: trainerToken } } = becomeTrainerResponse.json();
  if (firstName || lastName) {
    await prisma.user.update({ where: { id: userId }, data: { firstName, lastName } });
  }
  const trainer = await prisma.trainer.findUnique({ where: { userId }, select: { id: true } });
  return { userId, trainerId: trainer.id, accessToken: trainerToken, email };
}

/** Creates a plain student user and returns { userId, accessToken }. */
export async function createStudentWithToken(app) {
  const { userId, accessToken, email } = await signupUser(app, 'student');
  return { userId, accessToken, email };
}

/** Links `count` new students to the trainer (oldest first, the oldest `blockedCount` blocked) and returns their ids. */
export async function linkStudents(app, trainerId, { count, blockedCount = 0 }) {
  const studentIds = [];
  const baseTime = Date.UTC(2026, 0, 1);
  for (let index = 0; index < count; index += 1) {
    const { userId } = await createStudentWithToken(app);
    await prisma.trainerStudent.create({
      data: {
        trainerId,
        studentId: userId,
        activeOnPlan: index >= blockedCount,
        createdAt: new Date(baseTime + index * 60_000),
      },
    });
    studentIds.push(userId);
  }
  return studentIds;
}
