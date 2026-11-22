import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { signupVerified } from '../helpers/signup-user.js';
import { linkStudentByInvite } from '../helpers/link-student.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

e2eDescribe('e2e: trainer onboarding milestones (GET /me?include=trainerOnboarding)', () => {
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

  // ─── Helpers ─────────────────────────────────────────────────────────────

  async function createUserWithToken() {
    const email = `e2e+user-${Date.now()}@example.com`;
    const password = 'StrongPassw0rd!';

    const res = await signupVerified(app, {
      method: 'POST',
      url: '/auth/signup',
      payload: { email, password },
    });
    expect(res.statusCode).toBe(201);
    const { token: { accessToken } } = res.json();
    return { accessToken, email };
  }

  async function createTrainerWithToken() {
    const { accessToken: userToken, email } = await createUserWithToken();

    const becomeRes = await app.inject({
      method: 'PATCH',
      url: '/become-trainer',
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(becomeRes.statusCode).toBe(200);
    const { token: { accessToken } } = becomeRes.json();
    return { accessToken, email };
  }

  async function getOnboardingStatus(accessToken) {
    const res = await app.inject({
      method: 'GET',
      url: '/me?include=trainerOnboarding',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    return res.json().trainerOnboarding;
  }

  async function patchTrainerProfile(accessToken, payload) {
    return app.inject({
      method: 'PATCH',
      url: '/trainer',
      headers: { authorization: `Bearer ${accessToken}` },
      payload,
    });
  }

  async function patchUserProfile(accessToken, payload) {
    return app.inject({
      method: 'PATCH',
      url: '/me/profile',
      headers: { authorization: `Bearer ${accessToken}` },
      payload,
    });
  }

  async function uploadAvatar(accessToken) {
    const boundary = '----OnboardingAvatarBoundary';
    const payload = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="avatar.jpg"',
      'Content-Type: image/jpeg',
      '',
      Buffer.from('fake-jpeg-data').toString('binary'),
      `--${boundary}--`,
    ].join('\r\n');
    const res = await app.inject({
      method: 'POST',
      url: '/me/avatar',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload,
    });
    expect(res.statusCode).toBe(200);
  }

  // ─── Tests ───────────────────────────────────────────────────────────────

  it('returns trainerOnboarding: null for a user who is not a trainer', async () => {
    const { accessToken } = await createUserWithToken();

    const res = await app.inject({
      method: 'GET',
      url: '/me?include=trainerOnboarding',
      headers: { authorization: `Bearer ${accessToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().trainerOnboarding).toBeNull();
  });

  it('returns all milestones as null/false for a freshly created trainer', async () => {
    const { accessToken } = await createTrainerWithToken();

    const onboarding = await getOnboardingStatus(accessToken);

    expect(onboarding).not.toBeNull();
    expect(onboarding.profileCompletedAt).toBeNull();
    expect(onboarding.firstStudentLinkedAt).toBeNull();
    expect(onboarding.firstProtocolCreatedAt).toBeNull();
    expect(onboarding.profileCompleted).toBe(false);
    expect(onboarding.firstStudentLinked).toBe(false);
    expect(onboarding.firstProtocolCreated).toBe(false);
  });

  it('profileCompleted remains false after a partial PATCH /trainer (only firstName)', async () => {
    const { accessToken } = await createTrainerWithToken();

    const patchRes = await patchTrainerProfile(accessToken, {
      trainer: { firstName: 'Ana' },
    });
    expect(patchRes.statusCode).toBe(200);

    const onboarding = await getOnboardingStatus(accessToken);
    expect(onboarding.profileCompleted).toBe(false);
    expect(onboarding.profileCompletedAt).toBeNull();
  });

  it('sets profileCompleted=true and profileCompletedAt after all required fields are provided', async () => {
    const { accessToken } = await createTrainerWithToken();

    // Provide all required personal fields via PATCH /trainer
    const patchRes = await patchTrainerProfile(accessToken, {
      trainer: {
        firstName: 'Ana',
        lastName: 'Silva',
        birthDate: '1990-01-15',
      },
      address: {
        line1: 'Rua das Flores, 100',
        city: 'São Paulo',
        state: 'São Paulo',
        postalCode: '01310-100',
        country: 'Brazil',
      },
    });
    expect(patchRes.statusCode).toBe(200);

    // gender is set via PATCH /me/profile
    const profileRes = await app.inject({
      method: 'PATCH',
      url: '/me/profile',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { gender: 'female' },
    });
    expect(profileRes.statusCode).toBe(200);

    await uploadAvatar(accessToken);

    const onboarding = await getOnboardingStatus(accessToken);
    expect(onboarding.profileCompleted).toBe(true);
    expect(onboarding.profileCompletedAt).not.toBeNull();
    expect(typeof onboarding.profileCompletedAt).toBe('string');
  });

  it('profileCompletedAt does not change on subsequent profile updates (write-once)', async () => {
    const { accessToken } = await createTrainerWithToken();

    // Complete the profile
    await patchTrainerProfile(accessToken, {
      trainer: { firstName: 'Ana', lastName: 'Silva', birthDate: '1990-01-15' },
      address: {
        line1: 'Rua das Flores, 100',
        city: 'São Paulo',
        state: 'São Paulo',
        postalCode: '01310-100',
        country: 'Brazil',
      },
    });
    await app.inject({
      method: 'PATCH',
      url: '/me/profile',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { gender: 'female' },
    });

    await uploadAvatar(accessToken);

    const firstCheck = await getOnboardingStatus(accessToken);
    const firstTimestamp = firstCheck.profileCompletedAt;
    expect(firstTimestamp).not.toBeNull();

    // Update the profile again
    await patchTrainerProfile(accessToken, {
      trainer: { firstName: 'Ana Updated' },
    });

    const secondCheck = await getOnboardingStatus(accessToken);
    expect(secondCheck.profileCompletedAt).toBe(firstTimestamp);
  });

  it('sets firstStudentLinked=true and firstStudentLinkedAt after linking the first student', async () => {
    const { accessToken: trainerToken } = await createTrainerWithToken();
    const { email: studentEmail } = await createUserWithToken();

    await linkStudentByInvite(app, { trainerToken, email: studentEmail });

    const onboarding = await getOnboardingStatus(trainerToken);
    expect(onboarding.firstStudentLinked).toBe(true);
    expect(onboarding.firstStudentLinkedAt).not.toBeNull();
  });

  it('firstStudentLinkedAt does not change when linking a second student', async () => {
    const { accessToken: trainerToken } = await createTrainerWithToken();
    const { email: studentEmail1 } = await createUserWithToken();
    const { email: studentEmail2 } = await createUserWithToken();

    await linkStudentByInvite(app, { trainerToken, email: studentEmail1 });

    const firstCheck = await getOnboardingStatus(trainerToken);
    const firstTimestamp = firstCheck.firstStudentLinkedAt;

    await linkStudentByInvite(app, { trainerToken, email: studentEmail2 });

    const secondCheck = await getOnboardingStatus(trainerToken);
    expect(secondCheck.firstStudentLinkedAt).toBe(firstTimestamp);
  });

  it('sets firstProtocolCreated=true and firstProtocolCreatedAt after creating the first protocol', async () => {
    const { accessToken: trainerToken } = await createTrainerWithToken();
    const { email: assigneeEmail } = await createUserWithToken();

    // Link assignee first so they're accessible as a student
    await linkStudentByInvite(app, { trainerToken, email: assigneeEmail });

    // Get assignee ID from student list
    const studentsRes = await app.inject({
      method: 'GET',
      url: '/trainer/students',
      headers: { authorization: `Bearer ${trainerToken}` },
    });
    const [{ id: assigneeId }] = studentsRes.json();

    const protocolRes = await app.inject({
      method: 'POST',
      url: '/trainer/protocols',
      headers: { authorization: `Bearer ${trainerToken}` },
      payload: {
        assigneeId,
        name: 'First Protocol',
        startDate: '2025-01-01',
        expirationDate: '2025-06-30',
      },
    });
    expect(protocolRes.statusCode).toBe(201);

    const onboarding = await getOnboardingStatus(trainerToken);
    expect(onboarding.firstProtocolCreated).toBe(true);
    expect(onboarding.firstProtocolCreatedAt).not.toBeNull();
  });

  it('firstProtocolCreatedAt does not change when creating a second protocol', async () => {
    const { accessToken: trainerToken } = await createTrainerWithToken();
    const { email: assigneeEmail } = await createUserWithToken();

    await linkStudentByInvite(app, { trainerToken, email: assigneeEmail });

    const studentsRes = await app.inject({
      method: 'GET',
      url: '/trainer/students',
      headers: { authorization: `Bearer ${trainerToken}` },
    });
    const [{ id: assigneeId }] = studentsRes.json();

    const protocolPayload = {
      assigneeId,
      name: 'Protocol',
      startDate: '2025-01-01',
      expirationDate: '2025-06-30',
    };

    await app.inject({
      method: 'POST',
      url: '/trainer/protocols',
      headers: { authorization: `Bearer ${trainerToken}` },
      payload: protocolPayload,
    });

    const firstCheck = await getOnboardingStatus(trainerToken);
    const firstTimestamp = firstCheck.firstProtocolCreatedAt;

    await app.inject({
      method: 'POST',
      url: '/trainer/protocols',
      headers: { authorization: `Bearer ${trainerToken}` },
      payload: { ...protocolPayload, name: 'Second Protocol' },
    });

    const secondCheck = await getOnboardingStatus(trainerToken);
    expect(secondCheck.firstProtocolCreatedAt).toBe(firstTimestamp);
  });

  it('sets firstProtocolCreated=true when the trainer creates a protocol template via REST', async () => {
    const { accessToken: trainerToken } = await createTrainerWithToken();

    const res = await app.inject({
      method: 'POST',
      url: '/trainer/protocol-templates',
      headers: { authorization: `Bearer ${trainerToken}` },
      payload: { name: 'My First Template' },
    });
    expect(res.statusCode).toBe(201);

    const onboarding = await getOnboardingStatus(trainerToken);
    expect(onboarding.firstProtocolCreated).toBe(true);
    expect(onboarding.firstProtocolCreatedAt).not.toBeNull();
  });

  it('firstProtocolCreatedAt does not change when creating a second protocol template', async () => {
    const { accessToken: trainerToken } = await createTrainerWithToken();

    await app.inject({
      method: 'POST',
      url: '/trainer/protocol-templates',
      headers: { authorization: `Bearer ${trainerToken}` },
      payload: { name: 'First Template' },
    });

    const firstCheck = await getOnboardingStatus(trainerToken);
    const firstTimestamp = firstCheck.firstProtocolCreatedAt;
    expect(firstTimestamp).not.toBeNull();

    await app.inject({
      method: 'POST',
      url: '/trainer/protocol-templates',
      headers: { authorization: `Bearer ${trainerToken}` },
      payload: { name: 'Second Template' },
    });

    const secondCheck = await getOnboardingStatus(trainerToken);
    expect(secondCheck.firstProtocolCreatedAt).toBe(firstTimestamp);
  });

  it('sets profileCompleted=true immediately when a student who already has all required fields calls PATCH /become-trainer', async () => {
    // Create a user as a student with name, surname and avatar set
    const { accessToken: studentToken } = await createUserWithToken();

    const profileRes = await patchUserProfile(studentToken, {
      firstName: 'Carlos',
      lastName: 'Oliveira',
      gender: 'male',
      birthDate: '1988-03-20',
      address: {
        line1: 'Av. Paulista, 1000',
        city: 'São Paulo',
        state: 'São Paulo',
        postalCode: '01310-100',
        country: 'Brazil',
      },
    });
    expect(profileRes.statusCode).toBe(200);
    await uploadAvatar(studentToken);

    // Upgrade the student to trainer — the milestone should be set immediately
    const becomeRes = await app.inject({
      method: 'PATCH',
      url: '/become-trainer',
      headers: { authorization: `Bearer ${studentToken}` },
    });
    expect(becomeRes.statusCode).toBe(200);

    // Use the new trainer token returned by PATCH /become-trainer
    const { token: { accessToken: trainerToken } } = becomeRes.json();

    const onboarding = await getOnboardingStatus(trainerToken);
    expect(onboarding.profileCompleted).toBe(true);
    expect(onboarding.profileCompletedAt).not.toBeNull();
    expect(typeof onboarding.profileCompletedAt).toBe('string');
  });
});
