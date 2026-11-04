import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { createTrainerWithToken } from '../helpers/admin-users.js';
import { prisma } from '../../src/db.js';
import {
  createUser,
  createNutritionist,
  createLinkedPatient,
  birthDateForAge,
  auth,
  expectErrorContract,
} from '../helpers/nutrition-e2e.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

const AGE_YEARS = 29;
const WEIGHT_KG = 66;
const HEIGHT_CM = 165;
const BODY_FAT_PCT = 28;
const LEAN_MASS_KG = 47.52;
const ASSESSED_AT = '2026-10-20';
const WEIGHT_TRAINING_MET = 5;
const SESSION_MINUTES = 60;
const SECONDS_PER_MINUTE = 60;
const TRAINING_WEEK_DAYS = ['monday', 'wednesday', 'friday', 'saturday'];

e2eDescribe('e2e: patient sheet, overview and training activities', () => {
  let app;
  let nutri;
  let patient;

  beforeAll(async () => {
    app = await setupApp();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(async () => {
    await cleanDatabase();
    nutri = await createNutritionist(app);
    patient = await createLinkedPatient(app, nutri, { birthDate: birthDateForAge(AGE_YEARS) });
  });

  const sheetUrl = (patientId) => `/nutritionist/patients/${patientId}/sheet`;

  function putSheet(payload, token = nutri.accessToken, patientId = patient.userId) {
    return app.inject({ method: 'PUT', url: sheetUrl(patientId), headers: auth(token), payload });
  }

  const validSheet = { sex: 'female', weightKg: WEIGHT_KG, heightCm: HEIGHT_CM, bodyFatPct: BODY_FAT_PCT, assessedAt: ASSESSED_AT };

  describe('GET /nutritionist/patients/:patientId/sheet', () => {
    it('should answer 401 without authentication', async () => {
      const res = await app.inject({ method: 'GET', url: sheetUrl(patient.userId) });

      expect(res.statusCode).toBe(401);
    });

    it('should answer 403 for a user without the nutritionist role', async () => {
      const plain = await createUser(app);

      const res = await app.inject({ method: 'GET', url: sheetUrl(patient.userId), headers: auth(plain.accessToken) });

      expect(res.statusCode).toBe(403);
    });

    it('should not expose a patient linked to another nutritionist', async () => {
      const other = await createNutritionist(app);

      const res = await app.inject({ method: 'GET', url: sheetUrl(patient.userId), headers: auth(other.accessToken) });

      expect([403, 404]).toContain(res.statusCode);
    });

    it('should prefill birthDate/age, weight, height and body fat from the user data', async () => {
      await prisma.userHealthDetail.create({
        data: { userId: patient.userId, weight: WEIGHT_KG, height: HEIGHT_CM, bodyFat: BODY_FAT_PCT },
      });

      const res = await app.inject({ method: 'GET', url: sheetUrl(patient.userId), headers: auth(nutri.accessToken) });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        birthDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        age: AGE_YEARS,
        weightKg: WEIGHT_KG,
        heightCm: HEIGHT_CM,
        bodyFatPct: BODY_FAT_PCT,
        leanMassKg: LEAN_MASS_KG,
        assessedAt: null,
      });
    });

    it('should return nulls for the missing fields when the patient has no data', async () => {
      const res = await app.inject({ method: 'GET', url: sheetUrl(patient.userId), headers: auth(nutri.accessToken) });

      expect(res.json()).toMatchObject({ weightKg: null, heightCm: null, bodyFatPct: null, leanMassKg: null, assessedAt: null });
    });
  });

  describe('PUT /nutritionist/patients/:patientId/sheet', () => {
    it('should save sex, weight, height, body fat and assessment date and return the Sheet', async () => {
      const res = await putSheet(validSheet);

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        sex: 'female',
        age: AGE_YEARS,
        weightKg: WEIGHT_KG,
        heightCm: HEIGHT_CM,
        bodyFatPct: BODY_FAT_PCT,
        leanMassKg: LEAN_MASS_KG,
        assessedAt: ASSESSED_AT,
      });
    });

    it('should persist the saved values for the next GET', async () => {
      await putSheet(validSheet);

      const res = await app.inject({ method: 'GET', url: sheetUrl(patient.userId), headers: auth(nutri.accessToken) });

      expect(res.json()).toMatchObject({ sex: 'female', weightKg: WEIGHT_KG, assessedAt: ASSESSED_AT });
    });

    it('should accept a sheet without body fat and assessment date', async () => {
      const res = await putSheet({ sex: 'male', weightKg: 80, heightCm: 180 });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ sex: 'male', bodyFatPct: null, leanMassKg: null });
    });

    it.each([
      ['an unknown sex', { sex: 'other' }],
      ['a negative weight', { weightKg: -1 }],
      ['a body fat over 100', { bodyFatPct: 101 }],
      ['a missing height', { heightCm: undefined }],
    ])('should answer 400 VALIDATION_ERROR for %s', async (_label, override) => {
      const res = await putSheet({ ...validSheet, ...override });

      expectErrorContract(res, { statusCode: 400, error: 'VALIDATION_ERROR', messageCode: 'validation.failed' });
    });

    it('should answer 403 for a user without the nutritionist role', async () => {
      const plain = await createUser(app);

      const res = await putSheet(validSheet, plain.accessToken);

      expect(res.statusCode).toBe(403);
    });
  });

  describe('GET /nutritionist/patients/:patientId/training-activities', () => {
    const url = () => `/nutritionist/patients/${patient.userId}/training-activities`;

    async function giveActiveProtocol({ withSessions }) {
      const trainer = await createTrainerWithToken(app);
      const protocol = await prisma.trainingProtocol.create({
        data: { assigneeId: patient.userId, trainerId: trainer.trainerId, name: 'Hipertrofia', status: 'active', startDate: new Date('2026-10-01') },
      });
      const trainings = [];
      for (const [index, weekDay] of TRAINING_WEEK_DAYS.entries()) {
        trainings.push(
          await prisma.training.create({
            data: {
              trainingProtocolId: protocol.id,
              name: `Treino ${index}`,
              category: 'strength',
              weekDay,
              order: index,
              estimatedDurationSeconds: 45 * SECONDS_PER_MINUTE,
            },
          }),
        );
      }
      if (withSessions) {
        await prisma.workoutSession.create({
          data: {
            trainingId: trainings[0].id,
            userId: patient.userId,
            status: 'completed',
            startedAt: new Date(Date.now() - 24 * 3600 * 1000),
            finishedAt: new Date(),
            durationSeconds: SESSION_MINUTES * SECONDS_PER_MINUTE,
          },
        });
      }
    }

    it('should return an empty list when the patient has no active training protocol', async () => {
      const res = await app.inject({ method: 'GET', url: url(), headers: auth(nutri.accessToken) });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ items: [] });
    });

    it('should suggest weight training with sessions/week from the protocol days and the average session duration', async () => {
      await giveActiveProtocol({ withSessions: true });

      const res = await app.inject({ method: 'GET', url: url(), headers: auth(nutri.accessToken) });

      expect(res.json().items).toEqual([
        { name: expect.any(String), met: WEIGHT_TRAINING_MET, minutes: SESSION_MINUTES, perWeek: TRAINING_WEEK_DAYS.length },
      ]);
    });

    it('should fall back to the estimated training duration when there are no sessions yet', async () => {
      await giveActiveProtocol({ withSessions: false });

      const res = await app.inject({ method: 'GET', url: url(), headers: auth(nutri.accessToken) });

      expect(res.json().items[0]).toMatchObject({ minutes: 45, perWeek: TRAINING_WEEK_DAYS.length });
    });

    it('should answer 403 for a user without the nutritionist role', async () => {
      const plain = await createUser(app);

      const res = await app.inject({ method: 'GET', url: url(), headers: auth(plain.accessToken) });

      expect(res.statusCode).toBe(403);
    });
  });

  describe('GET /nutritionist/patients/:patientId/overview', () => {
    const overviewUrl = () => `/nutritionist/patients/${patient.userId}/overview`;

    it('should return the patient row, a null trainer and zeroed adherence', async () => {
      const res = await app.inject({ method: 'GET', url: overviewUrl(), headers: auth(nutri.accessToken) });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        patient: { id: patient.userId, email: patient.email, age: AGE_YEARS },
        trainer: null,
        adherence7d: {
          mealsDone: 0,
          percent: expect.any(Number),
          swaps: { total: 0, topPair: null },
          ateDifferent: { total: 0, topMealName: null },
        },
      });
    });

    it('should include the patient trainer when linked', async () => {
      const trainer = await createTrainerWithToken(app, { firstName: 'Paulo', lastName: 'Personal' });
      await prisma.trainerStudent.create({ data: { trainerId: trainer.trainerId, studentId: patient.userId } });

      const res = await app.inject({ method: 'GET', url: overviewUrl(), headers: auth(nutri.accessToken) });

      expect(res.json().trainer).toMatchObject({ firstName: 'Paulo', lastName: 'Personal' });
    });

    it('should answer 403 for a user without the nutritionist role', async () => {
      const plain = await createUser(app);

      const res = await app.inject({ method: 'GET', url: overviewUrl(), headers: auth(plain.accessToken) });

      expect(res.statusCode).toBe(403);
    });
  });
});
