import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { prisma } from '../../src/db.js';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

e2eDescribe('e2e: link student to trainer by email', () => {
  let app;

  beforeAll(async () => {
    app = await setupApp();
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  async function createTrainerWithToken() {
    const email = `e2e+trainer-${Date.now()}@example.com`;
    const password = 'StrongPassw0rd!';

    const signupRes = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { email, password },
    });
    expect(signupRes.statusCode).toBe(201);
    const { user: { id: userId }, token: { accessToken } } = signupRes.json();

    const becomeRes = await app.inject({
      method: 'PATCH',
      url: '/become-trainer',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(becomeRes.statusCode).toBe(200);
    const { token: { accessToken: trainerToken } } = becomeRes.json();

    return { userId, accessToken: trainerToken, email };
  }

  async function createStudent() {
    const email = `e2e+student-${Date.now()}@example.com`;
    const password = 'StrongPassw0rd!';

    const signupRes = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { email, password },
    });
    expect(signupRes.statusCode).toBe(201);
    const { user: { id: userId }, token: { accessToken } } = signupRes.json();

    return { userId, accessToken, email };
  }

  describe('POST /trainer/students', () => {
    it('links a student and returns their basic profile', async () => {
      const { accessToken: trainerToken, userId: trainerUserId } = await createTrainerWithToken();
      const { email: studentEmail, userId: studentId } = await createStudent();

      const res = await app.inject({
        method: 'POST',
        url: '/trainer/students',
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: { email: studentEmail },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body).toMatchObject({
        id: studentId,
        email: studentEmail,
      });
      expect(body).toHaveProperty('firstName');
      expect(body).toHaveProperty('lastName');
      expect(body).toHaveProperty('avatarUrl');

      const trainer = await prisma.trainer.findUnique({ where: { userId: trainerUserId } });
      const link = await prisma.trainerStudent.findUnique({
        where: { trainerId_studentId: { trainerId: trainer.id, studentId } },
      });
      expect(link).not.toBeNull();
    });

    it('returns 404 when no user exists with that email', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();

      const res = await app.inject({
        method: 'POST',
        url: '/trainer/students',
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: { email: 'nonexistent@example.com' },
      });

      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({
        error: 'NOT_FOUND',
        messageCode: 'student.notFound',
      });
    });

    it('returns 409 when student is already linked to the trainer', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { email: studentEmail } = await createStudent();

      const first = await app.inject({
        method: 'POST',
        url: '/trainer/students',
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: { email: studentEmail },
      });
      expect(first.statusCode).toBe(201);

      const second = await app.inject({
        method: 'POST',
        url: '/trainer/students',
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: { email: studentEmail },
      });

      expect(second.statusCode).toBe(409);
      expect(second.json()).toMatchObject({
        error: 'CONFLICT',
        messageCode: 'student.alreadyLinked',
      });
    });

    it('returns 422 when the trainer tries to link themselves', async () => {
      const { accessToken: trainerToken, email: trainerEmail } = await createTrainerWithToken();

      const res = await app.inject({
        method: 'POST',
        url: '/trainer/students',
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: { email: trainerEmail },
      });

      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({
        error: 'CANNOT_LINK_SELF',
        messageCode: 'student.cannotLinkSelf',
      });
    });

    it('returns 400 when email is missing', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();

      const res = await app.inject({
        method: 'POST',
        url: '/trainer/students',
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: {},
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 400 when email format is invalid', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();

      const res = await app.inject({
        method: 'POST',
        url: '/trainer/students',
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: { email: 'not-an-email' },
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 403 when the user does not have the TRAINER role', async () => {
      const { accessToken } = await createStudent();

      const res = await app.inject({
        method: 'POST',
        url: '/trainer/students',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { email: 'anyone@example.com' },
      });

      expect(res.statusCode).toBe(403);
    });

    it('returns 401 when unauthenticated', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/trainer/students',
        payload: { email: 'anyone@example.com' },
      });

      expect(res.statusCode).toBe(401);
    });

    it('allows the same student to be linked to multiple trainers', async () => {
      const { accessToken: trainerToken1 } = await createTrainerWithToken();

      await new Promise(resolve => setTimeout(resolve, 10));
      const { accessToken: trainerToken2 } = await createTrainerWithToken();

      const { email: studentEmail, userId: studentId } = await createStudent();

      const res1 = await app.inject({
        method: 'POST',
        url: '/trainer/students',
        headers: { authorization: `Bearer ${trainerToken1}` },
        payload: { email: studentEmail },
      });
      expect(res1.statusCode).toBe(201);

      const res2 = await app.inject({
        method: 'POST',
        url: '/trainer/students',
        headers: { authorization: `Bearer ${trainerToken2}` },
        payload: { email: studentEmail },
      });
      expect(res2.statusCode).toBe(201);

      const links = await prisma.trainerStudent.findMany({ where: { studentId } });
      expect(links).toHaveLength(2);
    });
  });

  describe('GET /trainer/students', () => {
    it('returns an empty array when no students are linked', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();

      const res = await app.inject({
        method: 'GET',
        url: '/trainer/students',
        headers: { authorization: `Bearer ${trainerToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([]);
    });

    it('returns all linked students', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { email: email1, userId: studentId1 } = await createStudent();
      await new Promise(resolve => setTimeout(resolve, 10));
      const { email: email2, userId: studentId2 } = await createStudent();

      await app.inject({
        method: 'POST',
        url: '/trainer/students',
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: { email: email1 },
      });
      await app.inject({
        method: 'POST',
        url: '/trainer/students',
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: { email: email2 },
      });

      const res = await app.inject({
        method: 'GET',
        url: '/trainer/students',
        headers: { authorization: `Bearer ${trainerToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toHaveLength(2);
      const ids = body.map(s => s.id);
      expect(ids).toContain(studentId1);
      expect(ids).toContain(studentId2);
      body.forEach(s => {
        expect(s).toHaveProperty('id');
        expect(s).toHaveProperty('email');
        expect(s).toHaveProperty('firstName');
        expect(s).toHaveProperty('lastName');
        expect(s).toHaveProperty('avatarUrl');
      });
    });

    it('only returns students linked to the requesting trainer', async () => {
      const { accessToken: trainerToken1 } = await createTrainerWithToken();
      await new Promise(resolve => setTimeout(resolve, 10));
      const { accessToken: trainerToken2 } = await createTrainerWithToken();

      const { email: sharedEmail } = await createStudent();
      await new Promise(resolve => setTimeout(resolve, 10));
      const { email: exclusiveEmail, userId: exclusiveId } = await createStudent();

      await app.inject({
        method: 'POST',
        url: '/trainer/students',
        headers: { authorization: `Bearer ${trainerToken1}` },
        payload: { email: sharedEmail },
      });
      await app.inject({
        method: 'POST',
        url: '/trainer/students',
        headers: { authorization: `Bearer ${trainerToken2}` },
        payload: { email: sharedEmail },
      });
      await app.inject({
        method: 'POST',
        url: '/trainer/students',
        headers: { authorization: `Bearer ${trainerToken2}` },
        payload: { email: exclusiveEmail },
      });

      const res = await app.inject({
        method: 'GET',
        url: '/trainer/students',
        headers: { authorization: `Bearer ${trainerToken2}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toHaveLength(2);
      expect(body.map(s => s.id)).toContain(exclusiveId);
    });

    it('returns 403 when the user does not have the TRAINER role', async () => {
      const { accessToken } = await createStudent();

      const res = await app.inject({
        method: 'GET',
        url: '/trainer/students',
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(res.statusCode).toBe(403);
    });

    it('returns 401 when unauthenticated', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/trainer/students',
      });

      expect(res.statusCode).toBe(401);
    });
  });

  describe('GET /trainer/students/search', () => {
    it('returns linked students that match by name or email', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { email: studentEmail1, userId: studentId1 } = await createStudent();
      await new Promise(resolve => setTimeout(resolve, 10));
      const { email: studentEmail2, userId: studentId2 } = await createStudent();

      await prisma.user.update({
        where: { id: studentId1 },
        data: { firstName: 'Carolina', lastName: 'Almeida' },
      });
      await prisma.user.update({
        where: { id: studentId2 },
        data: { firstName: 'Bruno', lastName: 'Silva' },
      });

      await app.inject({
        method: 'POST',
        url: '/trainer/students',
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: { email: studentEmail1 },
      });
      await app.inject({
        method: 'POST',
        url: '/trainer/students',
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: { email: studentEmail2 },
      });

      const byName = await app.inject({
        method: 'GET',
        url: '/trainer/students/search?q=carol',
        headers: { authorization: `Bearer ${trainerToken}` },
      });
      expect(byName.statusCode).toBe(200);
      expect(byName.json().map(s => s.id)).toContain(studentId1);

      const byEmail = await app.inject({
        method: 'GET',
        url: `/trainer/students/search?q=${encodeURIComponent(studentEmail2.slice(0, 8))}`,
        headers: { authorization: `Bearer ${trainerToken}` },
      });
      expect(byEmail.statusCode).toBe(200);
      expect(byEmail.json().map(s => s.id)).toContain(studentId2);
    });

    it('only returns students linked to the requesting trainer', async () => {
      const { accessToken: trainerToken1 } = await createTrainerWithToken();
      await new Promise(resolve => setTimeout(resolve, 10));
      const { accessToken: trainerToken2 } = await createTrainerWithToken();
      const { email: studentEmail } = await createStudent();

      await app.inject({
        method: 'POST',
        url: '/trainer/students',
        headers: { authorization: `Bearer ${trainerToken2}` },
        payload: { email: studentEmail },
      });

      const res = await app.inject({
        method: 'GET',
        url: `/trainer/students/search?q=${encodeURIComponent(studentEmail.slice(0, 8))}`,
        headers: { authorization: `Bearer ${trainerToken1}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([]);
    });

    it('returns 400 when q is missing', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();

      const res = await app.inject({
        method: 'GET',
        url: '/trainer/students/search',
        headers: { authorization: `Bearer ${trainerToken}` },
      });

      expect(res.statusCode).toBe(400);
    });
  });

  describe('DELETE /trainer/students/:studentId', () => {
    it('unlinks a student and returns 204, verifying the link is removed from the DB', async () => {
      const { accessToken: trainerToken, userId: trainerUserId } = await createTrainerWithToken();
      const { email: studentEmail, userId: studentId } = await createStudent();

      await app.inject({
        method: 'POST',
        url: '/trainer/students',
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: { email: studentEmail },
      });

      const res = await app.inject({
        method: 'DELETE',
        url: `/trainer/students/${studentId}`,
        headers: { authorization: `Bearer ${trainerToken}` },
      });

      expect(res.statusCode).toBe(204);

      const trainer = await prisma.trainer.findUnique({ where: { userId: trainerUserId } });
      const link = await prisma.trainerStudent.findUnique({
        where: { trainerId_studentId: { trainerId: trainer.id, studentId } },
      });
      expect(link).toBeNull();
    });

    it('returns 404 when the student is not linked to the trainer', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { userId: studentId } = await createStudent();

      const res = await app.inject({
        method: 'DELETE',
        url: `/trainer/students/${studentId}`,
        headers: { authorization: `Bearer ${trainerToken}` },
      });

      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({
        error: 'NOT_FOUND',
        messageCode: 'student.notLinked',
      });
    });

    it('returns 404 when the studentId does not correspond to any existing user', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const nonExistentId = '00000000-0000-0000-0000-000000000000';

      const res = await app.inject({
        method: 'DELETE',
        url: `/trainer/students/${nonExistentId}`,
        headers: { authorization: `Bearer ${trainerToken}` },
      });

      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({
        error: 'NOT_FOUND',
        messageCode: 'student.notLinked',
      });
    });

    it('does not affect other trainers\' links to the same student', async () => {
      const { accessToken: trainerToken1, userId: trainerUserId1 } = await createTrainerWithToken();
      await new Promise(resolve => setTimeout(resolve, 10));
      const { accessToken: trainerToken2 } = await createTrainerWithToken();

      const { email: studentEmail, userId: studentId } = await createStudent();

      await app.inject({
        method: 'POST',
        url: '/trainer/students',
        headers: { authorization: `Bearer ${trainerToken1}` },
        payload: { email: studentEmail },
      });
      await app.inject({
        method: 'POST',
        url: '/trainer/students',
        headers: { authorization: `Bearer ${trainerToken2}` },
        payload: { email: studentEmail },
      });

      const res = await app.inject({
        method: 'DELETE',
        url: `/trainer/students/${studentId}`,
        headers: { authorization: `Bearer ${trainerToken1}` },
      });

      expect(res.statusCode).toBe(204);

      const trainer1 = await prisma.trainer.findUnique({ where: { userId: trainerUserId1 } });
      const link1 = await prisma.trainerStudent.findUnique({
        where: { trainerId_studentId: { trainerId: trainer1.id, studentId } },
      });
      expect(link1).toBeNull();

      const allLinks = await prisma.trainerStudent.findMany({ where: { studentId } });
      expect(allLinks).toHaveLength(1);
    });

    it('returns 403 when the user does not have the TRAINER role', async () => {
      const { accessToken } = await createStudent();
      const nonExistentId = '00000000-0000-0000-0000-000000000000';

      const res = await app.inject({
        method: 'DELETE',
        url: `/trainer/students/${nonExistentId}`,
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(res.statusCode).toBe(403);
    });

    it('returns 401 when unauthenticated', async () => {
      const nonExistentId = '00000000-0000-0000-0000-000000000000';

      const res = await app.inject({
        method: 'DELETE',
        url: `/trainer/students/${nonExistentId}`,
      });

      expect(res.statusCode).toBe(401);
    });
  });
});
