import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { ActivityLevel } from '../../src/constants/diet.js';
import { signupVerified } from '../helpers/signup-user.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

e2eDescribe('e2e: nutritionist patients', () => {
  let app;

  beforeAll(async () => {
    app = await setupApp();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  // ─── Auth helpers ─────────────────────────────────────────────────────────

  async function createUserWithToken(suffix = Date.now()) {
    const email = `e2e+nutri-${suffix}@example.com`;
    const password = 'StrongPassw0rd!';
    const res = await signupVerified(app, {
      method: 'POST',
      url: '/auth/signup',
      payload: { email, password },
    });
    expect(res.statusCode).toBe(201);
    const { user: { id: userId }, token: { accessToken } } = res.json();
    return { userId, accessToken, email };
  }

  async function createNutritionistWithToken() {
    const { userId, accessToken: rawToken, email } = await createUserWithToken(`nutri-${Date.now()}`);
    const becomeRes = await app.inject({
      method: 'PATCH',
      url: '/become-nutritionist',
      headers: { authorization: `Bearer ${rawToken}` },
    });
    expect(becomeRes.statusCode).toBe(200);
    const { token: { accessToken } } = becomeRes.json();
    return { userId, accessToken, email };
  }

  async function createPatientWithToken() {
    const { userId, accessToken, email } = await createUserWithToken(`patient-${Date.now()}`);
    return { userId, accessToken, email };
  }

  // ─── POST /nutritionist/patients ─────────────────────────────────────────

  describe('POST /nutritionist/patients', () => {
    it('links a patient and returns the link with patient info', async () => {
      const { accessToken } = await createNutritionistWithToken();
      const { userId: patientId, email: patientEmail } = await createPatientWithToken();

      const res = await app.inject({
        method: 'POST',
        url: '/nutritionist/patients',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { email: patientEmail },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body).toHaveProperty('id');
      expect(body).toHaveProperty('patientId', patientId);
      expect(body).toHaveProperty('status');
      expect(body.patient).toMatchObject({ id: patientId });
    });

    it('links a patient with optional notes', async () => {
      const { accessToken } = await createNutritionistWithToken();
      const { email: patientEmail } = await createPatientWithToken();

      const res = await app.inject({
        method: 'POST',
        url: '/nutritionist/patients',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { email: patientEmail, notes: 'Paciente com restrição a lactose' },
      });

      expect(res.statusCode).toBe(201);
      expect(res.json()).toHaveProperty('notes', 'Paciente com restrição a lactose');
    });

    it('returns 409 when patient is already linked', async () => {
      const { accessToken } = await createNutritionistWithToken();
      const { email: patientEmail } = await createPatientWithToken();

      await app.inject({
        method: 'POST',
        url: '/nutritionist/patients',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { email: patientEmail },
      });

      const res = await app.inject({
        method: 'POST',
        url: '/nutritionist/patients',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { email: patientEmail },
      });

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({
        error: 'PATIENT_ALREADY_LINKED',
        messageCode: 'diet.patientAlreadyLinked',
      });
    });

    it('returns 404 when patient user does not exist', async () => {
      const { accessToken } = await createNutritionistWithToken();
      const fakePatientEmail = 'nonexistent-patient@example.com';

      const res = await app.inject({
        method: 'POST',
        url: '/nutritionist/patients',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { email: fakePatientEmail },
      });

      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({
        error: 'PATIENT_NOT_FOUND',
        messageCode: 'diet.patientNotFound',
      });
    });

    it('returns 401 without authentication', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/nutritionist/patients',
        payload: { patientId: '00000000-0000-0000-0000-000000000000' },
      });

      expect(res.statusCode).toBe(401);
    });

    it('returns 403 when user is not a nutritionist', async () => {
      const { accessToken } = await createPatientWithToken();
      const { email: patientEmail } = await createPatientWithToken();

      const res = await app.inject({
        method: 'POST',
        url: '/nutritionist/patients',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { email: patientEmail },
      });

      expect(res.statusCode).toBe(403);
    });

    it('re-links a previously unlinked patient successfully', async () => {
      const { accessToken } = await createNutritionistWithToken();
      const { userId: patientId, email: patientEmail } = await createPatientWithToken();

      // link
      await app.inject({
        method: 'POST',
        url: '/nutritionist/patients',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { email: patientEmail },
      });

      // unlink
      await app.inject({
        method: 'DELETE',
        url: `/nutritionist/patients/${patientId}`,
        headers: { authorization: `Bearer ${accessToken}` },
      });

      // re-link
      const res = await app.inject({
        method: 'POST',
        url: '/nutritionist/patients',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { email: patientEmail },
      });

      expect(res.statusCode).toBe(201);
      expect(res.json()).toHaveProperty('patientId', patientId);
    });
  });

  // ─── GET /nutritionist/patients ──────────────────────────────────────────

  describe('GET /nutritionist/patients', () => {
    it('returns an empty list when no patients are linked', async () => {
      const { accessToken } = await createNutritionistWithToken();

      const res = await app.inject({
        method: 'GET',
        url: '/nutritionist/patients',
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([]);
    });

    it('returns linked patients with patient info', async () => {
      const { accessToken } = await createNutritionistWithToken();
      const { userId: patientId, email: patientEmail } = await createPatientWithToken();

      await app.inject({
        method: 'POST',
        url: '/nutritionist/patients',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { email: patientEmail },
      });

      const res = await app.inject({
        method: 'GET',
        url: '/nutritionist/patients',
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(res.statusCode).toBe(200);
      const list = res.json();
      expect(list).toHaveLength(1);
      expect(list[0].patient).toMatchObject({ id: patientId });
    });

    it('does not return unlinked (soft-deleted) patients', async () => {
      const { accessToken } = await createNutritionistWithToken();
      const { userId: patientId, email: patientEmail } = await createPatientWithToken();

      await app.inject({
        method: 'POST',
        url: '/nutritionist/patients',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { email: patientEmail },
      });

      await app.inject({
        method: 'DELETE',
        url: `/nutritionist/patients/${patientId}`,
        headers: { authorization: `Bearer ${accessToken}` },
      });

      const res = await app.inject({
        method: 'GET',
        url: '/nutritionist/patients',
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([]);
    });

    it('returns 401 without authentication', async () => {
      const res = await app.inject({ method: 'GET', url: '/nutritionist/patients' });
      expect(res.statusCode).toBe(401);
    });
  });

  // ─── DELETE /nutritionist/patients/:patientId ─────────────────────────────

  describe('DELETE /nutritionist/patients/:patientId', () => {
    it('unlinks a patient and returns the updated link record', async () => {
      const { accessToken } = await createNutritionistWithToken();
      const { userId: patientId, email: patientEmail } = await createPatientWithToken();

      await app.inject({
        method: 'POST',
        url: '/nutritionist/patients',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { email: patientEmail },
      });

      const res = await app.inject({
        method: 'DELETE',
        url: `/nutritionist/patients/${patientId}`,
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toHaveProperty('deletedAt');
    });

    it('returns 404 when patient is not linked', async () => {
      const { accessToken } = await createNutritionistWithToken();
      const { userId: patientId } = await createPatientWithToken();

      const res = await app.inject({
        method: 'DELETE',
        url: `/nutritionist/patients/${patientId}`,
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({
        error: 'PATIENT_NOT_LINKED',
        messageCode: 'diet.patientNotLinked',
      });
    });

    it('returns 401 without authentication', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/nutritionist/patients/00000000-0000-0000-0000-000000000000',
      });
      expect(res.statusCode).toBe(401);
    });
  });

  // ─── PUT /nutritionist/patients/:patientId/metabolic-profile ─────────────

  describe('PUT /nutritionist/patients/:patientId/metabolic-profile', () => {
    it('creates metabolic profile with weight and height', async () => {
      const { accessToken } = await createNutritionistWithToken();
      const { userId: patientId, email: patientEmail } = await createPatientWithToken();

      await app.inject({
        method: 'POST',
        url: '/nutritionist/patients',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { email: patientEmail },
      });

      const res = await app.inject({
        method: 'PUT',
        url: `/nutritionist/patients/${patientId}/metabolic-profile`,
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { weightKg: 75, heightCm: 175 },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toHaveProperty('patientId', patientId);
      expect(body.weightKg).toBe(75);
      expect(body.heightCm).toBe(175);
    });

    it('calculates TMB and GET when formula and activity level are provided', async () => {
      const { accessToken } = await createNutritionistWithToken();
      const { userId: patientId, email: patientEmail } = await createPatientWithToken();

      // Update patient profile so the service can derive age/gender
      const { accessToken: _patientToken } = await app
        .inject({
          method: 'GET',
          url: '/me',
          headers: { authorization: `Bearer ${(await signupVerified(app, { method: 'POST', url: '/auth/signup', payload: { email: `temp-${Date.now()}@example.com`, password: 'StrongPassw0rd!' } })).json().token.accessToken}` },
        })
        .then(() => ({ accessToken: '' }));

      await app.inject({
        method: 'POST',
        url: '/nutritionist/patients',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { email: patientEmail },
      });

      const res = await app.inject({
        method: 'PUT',
        url: `/nutritionist/patients/${patientId}/metabolic-profile`,
        headers: { authorization: `Bearer ${accessToken}` },
        payload: {
          tmbKcal: 1800,
          activityLevel: ActivityLevel.SEDENTARIO,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toHaveProperty('tmbKcal', 1800);
      // 1800 * 1.2 = 2160
      expect(body).toHaveProperty('getKcal', 2160);
      expect(body).toHaveProperty('palMultiplier', 1.2);
    });

    it('returns 404 when patient is not linked to this nutritionist', async () => {
      const { accessToken } = await createNutritionistWithToken();
      const { userId: unlinkedPatientId } = await createPatientWithToken();

      const res = await app.inject({
        method: 'PUT',
        url: `/nutritionist/patients/${unlinkedPatientId}/metabolic-profile`,
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { weightKg: 70 },
      });

      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({
        error: 'PATIENT_NOT_LINKED',
        messageCode: 'diet.patientNotLinked',
      });
    });

    it('updates an existing metabolic profile (upsert)', async () => {
      const { accessToken } = await createNutritionistWithToken();
      const { userId: patientId, email: patientEmail } = await createPatientWithToken();

      await app.inject({
        method: 'POST',
        url: '/nutritionist/patients',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { email: patientEmail },
      });

      await app.inject({
        method: 'PUT',
        url: `/nutritionist/patients/${patientId}/metabolic-profile`,
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { weightKg: 75 },
      });

      // Second upsert — should update, not create a new record
      const res = await app.inject({
        method: 'PUT',
        url: `/nutritionist/patients/${patientId}/metabolic-profile`,
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { weightKg: 80, heightCm: 180 },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().weightKg).toBe(80);
      expect(res.json().heightCm).toBe(180);
    });

    it('returns 401 without authentication', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/nutritionist/patients/00000000-0000-0000-0000-000000000000/metabolic-profile',
        payload: { weightKg: 70 },
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 403 when caller is not a nutritionist', async () => {
      const { userId: patientId, accessToken: patientToken } = await createPatientWithToken();

      const res = await app.inject({
        method: 'PUT',
        url: `/nutritionist/patients/${patientId}/metabolic-profile`,
        headers: { authorization: `Bearer ${patientToken}` },
        payload: { weightKg: 70 },
      });

      expect(res.statusCode).toBe(403);
    });
  });
});
