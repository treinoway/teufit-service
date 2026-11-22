import { prisma } from '../../src/db.js';
import { StudentInviteMessageCode } from '../../src/constants/student-invite.js';

const INVITE_URL = '/trainer/student-invites';
const MY_INVITES_URL = '/my/trainer/invites';
const INVITED_STATUS = 201;
const ALREADY_LINKED_STATUS = 409;
const ACCEPTED_STATUS = 200;

// Builds the Authorization header for a bearer token.
function bearer(token) {
  return { authorization: `Bearer ${token}` };
}

// Signs an access token for the account that owns the e-mail (the student answering the invite in the app).
async function signStudentToken(app, email) {
  const student = await prisma.user.findFirst({
    where: { email: { equals: email, mode: 'insensitive' } },
    select: { id: true, email: true, roles: true, status: true },
  });
  if (!student) throw new Error(`linkStudentByInvite: no account owns ${email}; create (and verify) the student first`);
  return app.jwt.sign({ sub: student.id, email: student.email, roles: student.roles, status: student.status });
}

// True when the trainer invite was refused only because the student is already linked.
function isAlreadyLinked(response) {
  return response.statusCode === ALREADY_LINKED_STATUS && response.json().messageCode === StudentInviteMessageCode.ALREADY_LINKED;
}

/**
 * Links an EXISTING, e-mail-verified student to a trainer as production does: the trainer invites and the student accepts in the app (plan and invite caps apply; throws when a step is refused).
 *
 * @param {object} app - Fastify instance.
 * @param {{ trainerToken: string, email: string, studentToken?: string, allowAlreadyLinked?: boolean }} options -
 *   `studentToken` defaults to a token signed for the owner of `email`; `allowAlreadyLinked` makes a repeated link a no-op.
 * @returns {Promise<{ inviteId: string|null, alreadyLinked: boolean }>}
 */
export async function linkStudentByInvite(app, { trainerToken, email, studentToken, allowAlreadyLinked = false }) {
  const inviteResponse = await app.inject({ method: 'POST', url: INVITE_URL, headers: bearer(trainerToken), payload: { email } });
  if (allowAlreadyLinked && isAlreadyLinked(inviteResponse)) return { inviteId: null, alreadyLinked: true };
  if (inviteResponse.statusCode !== INVITED_STATUS) {
    throw new Error(`linkStudentByInvite: invite refused for ${email}: ${inviteResponse.statusCode} ${inviteResponse.body}`);
  }

  const inviteId = inviteResponse.json().invite.id;
  const acceptResponse = await app.inject({
    method: 'POST',
    url: `${MY_INVITES_URL}/${inviteId}/accept`,
    headers: bearer(studentToken ?? (await signStudentToken(app, email))),
    payload: {},
  });
  if (acceptResponse.statusCode !== ACCEPTED_STATUS) {
    throw new Error(`linkStudentByInvite: accept refused for ${email}: ${acceptResponse.statusCode} ${acceptResponse.body}`);
  }
  return { inviteId, alreadyLinked: false };
}
