import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

e2eDescribe('e2e: training protocols', () => {
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

    const signupResponse = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { email, password },
    });
    expect(signupResponse.statusCode).toBe(201);
    const { user: { id: userId }, token: { accessToken } } = signupResponse.json();

    const becomeTrainerResponse = await app.inject({
      method: 'PATCH',
      url: '/become-trainer',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(becomeTrainerResponse.statusCode).toBe(200);
    const { token: { accessToken: trainerToken } } = becomeTrainerResponse.json();

    return { userId, accessToken: trainerToken };
  }

  async function createAssigneeWithToken(firstName = 'John', lastName = 'Doe') {
    const email = `e2e+assignee-${Date.now()}@example.com`;
    const password = 'StrongPassw0rd!';

    const signupResponse = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { email, password },
    });
    expect(signupResponse.statusCode).toBe(201);
    const { user: { id: userId }, token: { accessToken } } = signupResponse.json();

    await app.inject({
      method: 'PATCH',
      url: '/me/profile',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { firstName, lastName },
    });

    return { userId, accessToken };
  }

  describe('POST /trainer/protocols', () => {
    it('creates protocol and returns assignee with id, firstName, lastName, avatarUrl', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { userId: assigneeId } = await createAssigneeWithToken('Jane', 'Smith');

      const createResponse = await app.inject({
        method: 'POST',
        url: '/trainer/protocols',
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: {
          assigneeId,
          name: 'Protocol Hipertrofia',
          startDate: '2025-02-01',
        },
      });

      expect(createResponse.statusCode).toBe(201);
      const body = createResponse.json();

      expect(body).toHaveProperty('id');
      expect(body).toHaveProperty('assigneeId', assigneeId);
      expect(body).toHaveProperty('name', 'Protocol Hipertrofia');
      expect(body).toHaveProperty('assignee');
      expect(body.assignee).toMatchObject({
        id: assigneeId,
        firstName: 'Jane',
        lastName: 'Smith',
      });
      expect(body.assignee).toHaveProperty('avatarUrl');
    });

    it('returns 404 when assignee user does not exist', async () => {
      const { accessToken } = await createTrainerWithToken();
      const fakeAssigneeId = '00000000-0000-0000-0000-000000000000';

      const response = await app.inject({
        method: 'POST',
        url: '/trainer/protocols',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: {
          assigneeId: fakeAssigneeId,
          name: 'Protocol',
          startDate: '2025-02-01',
        },
      });

      expect(response.statusCode).toBe(404);
    });

    it('rejects without authentication', async () => {
      const { userId: assigneeId } = await createAssigneeWithToken();

      const response = await app.inject({
        method: 'POST',
        url: '/trainer/protocols',
        payload: {
          assigneeId,
          name: 'Protocol',
          startDate: '2025-02-01',
        },
      });

      expect(response.statusCode).toBe(401);
    });
  });

  describe('GET /trainer/protocols', () => {
    it('returns protocols with assignee info', async () => {
      const { accessToken } = await createTrainerWithToken();
      const { userId: assigneeId } = await createAssigneeWithToken('Maria', 'Silva');

      await app.inject({
        method: 'POST',
        url: '/trainer/protocols',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: {
          assigneeId,
          name: 'Protocol A',
          startDate: '2025-02-01',
        },
      });

      const listResponse = await app.inject({
        method: 'GET',
        url: '/trainer/protocols',
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(listResponse.statusCode).toBe(200);
      const protocols = listResponse.json();
      expect(protocols).toHaveLength(1);
      expect(protocols[0]).toHaveProperty('assignee');
      expect(protocols[0].assignee).toMatchObject({
        id: assigneeId,
        firstName: 'Maria',
        lastName: 'Silva',
      });
    });
  });

  describe('GET /trainer/protocols/:id', () => {
    it('returns protocol by id with assignee', async () => {
      const { accessToken } = await createTrainerWithToken();
      const { userId: assigneeId } = await createAssigneeWithToken('Carlos', 'Santos');

      const createResponse = await app.inject({
        method: 'POST',
        url: '/trainer/protocols',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: {
          assigneeId,
          name: 'Protocol Detalhado',
          startDate: '2025-02-01',
        },
      });
      const { id: protocolId } = createResponse.json();

      const getResponse = await app.inject({
        method: 'GET',
        url: `/trainer/protocols/${protocolId}`,
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(getResponse.statusCode).toBe(200);
      const body = getResponse.json();
      expect(body).toHaveProperty('id', protocolId);
      expect(body).toHaveProperty('assignee');
      expect(body.assignee).toMatchObject({
        id: assigneeId,
        firstName: 'Carlos',
        lastName: 'Santos',
      });
    });
  });

  describe('PATCH /trainer/protocols/:id', () => {
    it('updates protocol and returns assignee', async () => {
      const { accessToken } = await createTrainerWithToken();
      const { userId: assigneeId } = await createAssigneeWithToken('Ana', 'Costa');

      const createResponse = await app.inject({
        method: 'POST',
        url: '/trainer/protocols',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: {
          assigneeId,
          name: 'Original Name',
          startDate: '2025-02-01',
        },
      });
      const { id: protocolId } = createResponse.json();

      const updateResponse = await app.inject({
        method: 'PATCH',
        url: `/trainer/protocols/${protocolId}`,
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { name: 'Updated Name' },
      });

      expect(updateResponse.statusCode).toBe(200);
      const body = updateResponse.json();
      expect(body).toHaveProperty('name', 'Updated Name');
      expect(body).toHaveProperty('assignee');
      expect(body.assignee).toMatchObject({
        id: assigneeId,
        firstName: 'Ana',
        lastName: 'Costa',
      });
    });
  });

  describe('GET /student/protocols', () => {
    it('returns protocols assigned to authenticated user', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { userId: assigneeId, accessToken: assigneeToken } = await createAssigneeWithToken('Pedro', 'Lima');

      await app.inject({
        method: 'POST',
        url: '/trainer/protocols',
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: {
          assigneeId,
          name: 'Meu Protocolo',
          startDate: '2025-02-01',
        },
      });

      const response = await app.inject({
        method: 'GET',
        url: '/student/protocols',
        headers: { authorization: `Bearer ${assigneeToken}` },
      });

      expect(response.statusCode).toBe(200);
      const protocols = response.json();
      expect(protocols).toHaveLength(1);
      expect(protocols[0]).toHaveProperty('name', 'Meu Protocolo');
      expect(protocols[0]).toHaveProperty('trainer');
    });
  });
});
