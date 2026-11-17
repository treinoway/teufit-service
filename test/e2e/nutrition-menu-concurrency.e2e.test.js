import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { createNutritionist, createLinkedPatient, getPlan, planWrite, auth } from '../helpers/nutrition-e2e.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

const ROUNDS = 8;
const SERVER_ERROR_FLOOR = 500;

e2eDescribe('e2e: concurrent menu writes on the same meal', () => {
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
    patient = await createLinkedPatient(app, nutri);
  });

  it('should never answer 500 when deleteMeal and addOption race on the same meal', async () => {
    const plan = await getPlan(app, nutri, patient.userId);
    for (let round = 0; round < ROUNDS; round += 1) {
      const created = await planWrite(app, nutri, 'POST', `/nutritionist/plans/${plan.id}/meals`, { name: `Refeição ${round}`, time: '07:00' });
      const meal = created.meals[created.meals.length - 1];

      const responses = await Promise.all([
        app.inject({ method: 'DELETE', url: `/nutritionist/meals/${meal.id}`, headers: auth(nutri.accessToken) }),
        app.inject({ method: 'POST', url: `/nutritionist/meals/${meal.id}/options`, headers: auth(nutri.accessToken) }),
      ]);

      for (const res of responses) expect(res.statusCode, res.body).toBeLessThan(SERVER_ERROR_FLOOR);
    }
  });
});
