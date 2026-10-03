import "dotenv/config";
import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import { prisma } from "../../src/db.js";
import { setupApp } from "../helpers/setup-app.js";
import { cleanDatabase } from "../helpers/db-cleanup.js";
import { provisionTrainerPlan } from "../helpers/platform-plan.js";
import { signupVerified } from '../helpers/signup-user.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

e2eDescribe("e2e: trainer branding", () => {
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
    const email = `e2e+trainer-branding-${Date.now()}@example.com`;
    const password = "StrongPassw0rd!";

    const signupRes = await signupVerified(app, {
      method: "POST",
      url: "/auth/signup",
      payload: { email, password },
    });
    expect(signupRes.statusCode).toBe(201);
    const {
      user: { id: userId },
      token: { accessToken },
    } = signupRes.json();

    const becomeRes = await app.inject({
      method: "PATCH",
      url: "/become-trainer",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(becomeRes.statusCode).toBe(200);
    const {
      token: { accessToken: trainerToken },
    } = becomeRes.json();

    const trainerRecord = await prisma.trainer.findUnique({
      where: { userId },
      select: { id: true },
    });

    // Trainers created via signup + become-trainer have no PlatformSubscription
    // row, so getTrainerPlan() defaults them to FREE (branding: false). Provision
    // DIAMOND so branding routes under test aren't blocked by the plan gate.
    await provisionTrainerPlan(trainerRecord.id);

    return {
      userId,
      trainerId: trainerRecord.id,
      accessToken: trainerToken,
      email,
    };
  }

  async function createStudentWithToken() {
    const email = `e2e+student-branding-${Date.now()}@example.com`;
    const password = "StrongPassw0rd!";

    const signupRes = await signupVerified(app, {
      method: "POST",
      url: "/auth/signup",
      payload: { email, password },
    });
    expect(signupRes.statusCode).toBe(201);
    const {
      user: { id: userId },
      token: { accessToken },
    } = signupRes.json();

    return { userId, accessToken, email };
  }

  function createMultipartPayload({ filename, mimetype, content }) {
    const boundary = "----WebKitFormBoundary7MA4YWxkTrZu0gW";
    const parts = [];
    parts.push(`--${boundary}`);
    parts.push(
      `Content-Disposition: form-data; name="file"; filename="${filename}"`,
    );
    parts.push(`Content-Type: ${mimetype}`);
    parts.push("");
    parts.push(content.toString("binary"));
    parts.push(`--${boundary}--`);
    return {
      payload: parts.join("\r\n"),
      contentType: `multipart/form-data; boundary=${boundary}`,
    };
  }

  // ─── PUT /trainer/branding ─────────────────────────────────────────────────

  describe("PUT /trainer/branding", () => {
    it("creates branding with valid primaryColor", async () => {
      const { accessToken } = await createTrainerWithToken();

      const res = await app.inject({
        method: "PUT",
        url: "/trainer/branding",
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { primaryColor: "#FF5733" },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({ primaryColor: "#FF5733" });
      expect(body.id).toBeTruthy();
    });

    it("creates branding with primaryColor and welcomeMessage", async () => {
      const { accessToken } = await createTrainerWithToken();

      const res = await app.inject({
        method: "PUT",
        url: "/trainer/branding",
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { primaryColor: "#123456", welcomeMessage: "Hello student!" },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        primaryColor: "#123456",
        welcomeMessage: "Hello student!",
      });
    });

    it("creates branding with primaryColor, secondaryColor, and welcomeMessage", async () => {
      const { accessToken } = await createTrainerWithToken();

      const res = await app.inject({
        method: "PUT",
        url: "/trainer/branding",
        headers: { authorization: `Bearer ${accessToken}` },
        payload: {
          primaryColor: "#123456",
          secondaryColor: "#654321",
          welcomeMessage: "Hello!",
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        primaryColor: "#123456",
        secondaryColor: "#654321",
        welcomeMessage: "Hello!",
      });
    });

    it("returns secondaryColor as null when not provided", async () => {
      const { accessToken } = await createTrainerWithToken();

      const res = await app.inject({
        method: "PUT",
        url: "/trainer/branding",
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { primaryColor: "#FF5733" },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().secondaryColor).toBeNull();
    });

    it("returns 400 for invalid secondaryColor (no hash)", async () => {
      const { accessToken } = await createTrainerWithToken();

      const res = await app.inject({
        method: "PUT",
        url: "/trainer/branding",
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { primaryColor: "#FF5733", secondaryColor: "AABBCC" },
      });

      expect(res.statusCode).toBe(400);
    });

    it("updates existing branding on second PUT", async () => {
      const { accessToken } = await createTrainerWithToken();

      await app.inject({
        method: "PUT",
        url: "/trainer/branding",
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { primaryColor: "#FF5733" },
      });

      const res = await app.inject({
        method: "PUT",
        url: "/trainer/branding",
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { primaryColor: "#AABBCC" },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ primaryColor: "#AABBCC" });
    });

    it("returns 400 for invalid hex color (no hash)", async () => {
      const { accessToken } = await createTrainerWithToken();

      const res = await app.inject({
        method: "PUT",
        url: "/trainer/branding",
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { primaryColor: "FF5733" },
      });

      expect(res.statusCode).toBe(400);
    });

    it("returns 400 for welcomeMessage exceeding 200 characters", async () => {
      const { accessToken } = await createTrainerWithToken();

      const res = await app.inject({
        method: "PUT",
        url: "/trainer/branding",
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { primaryColor: "#FF5733", welcomeMessage: "a".repeat(201) },
      });

      expect(res.statusCode).toBe(400);
    });

    it("returns 401 without auth token", async () => {
      const res = await app.inject({
        method: "PUT",
        url: "/trainer/branding",
        payload: { primaryColor: "#FF5733" },
      });

      expect(res.statusCode).toBe(401);
    });

    it("returns 403 when user does not have TRAINER role", async () => {
      const { accessToken } = await createStudentWithToken();

      const res = await app.inject({
        method: "PUT",
        url: "/trainer/branding",
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { primaryColor: "#FF5733" },
      });

      expect(res.statusCode).toBe(403);
    });
  });

  // ─── GET /trainer/branding ─────────────────────────────────────────────────

  describe("GET /trainer/branding", () => {
    it("returns null when trainer has not configured branding", async () => {
      const { accessToken } = await createTrainerWithToken();

      const res = await app.inject({
        method: "GET",
        url: "/trainer/branding",
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toBeNull();
    });

    it("returns branding after it has been created", async () => {
      const { accessToken } = await createTrainerWithToken();

      await app.inject({
        method: "PUT",
        url: "/trainer/branding",
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { primaryColor: "#FF5733", welcomeMessage: "Hi!" },
      });

      const res = await app.inject({
        method: "GET",
        url: "/trainer/branding",
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        primaryColor: "#FF5733",
        welcomeMessage: "Hi!",
      });
    });

    it("returns 401 without auth token", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/trainer/branding",
      });

      expect(res.statusCode).toBe(401);
    });

    it("returns 403 when user does not have TRAINER role", async () => {
      const { accessToken } = await createStudentWithToken();

      const res = await app.inject({
        method: "GET",
        url: "/trainer/branding",
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(res.statusCode).toBe(403);
    });
  });

  // ─── POST /trainer/branding/logo ───────────────────────────────────────────

  describe("POST /trainer/branding/logo", () => {
    it("returns 404 when branding has not been created yet", async () => {
      const { accessToken } = await createTrainerWithToken();

      const { payload, contentType } = createMultipartPayload({
        filename: "logo.jpg",
        mimetype: "image/jpeg",
        content: Buffer.from("fake-logo"),
      });

      const res = await app.inject({
        method: "POST",
        url: "/trainer/branding/logo",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": contentType,
        },
        payload,
      });

      expect(res.statusCode).toBe(404);
      const body = res.json();
      expect(body).toMatchObject({
        error: "NOT_FOUND",
        messageCode: "branding.notFound",
      });
    });

    it("uploads logo and returns updated branding", async () => {
      const { accessToken } = await createTrainerWithToken();

      await app.inject({
        method: "PUT",
        url: "/trainer/branding",
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { primaryColor: "#FF5733" },
      });

      const { payload, contentType } = createMultipartPayload({
        filename: "logo.jpg",
        mimetype: "image/jpeg",
        content: Buffer.from("fake-logo"),
      });

      const res = await app.inject({
        method: "POST",
        url: "/trainer/branding/logo",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": contentType,
        },
        payload,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.logoUrl).toBeTruthy();
      expect(body.primaryColor).toBe("#FF5733");
    });

    it("returns 400 for unsupported MIME type", async () => {
      const { accessToken } = await createTrainerWithToken();

      await app.inject({
        method: "PUT",
        url: "/trainer/branding",
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { primaryColor: "#FF5733" },
      });

      const { payload, contentType } = createMultipartPayload({
        filename: "logo.gif",
        mimetype: "image/gif",
        content: Buffer.from("fake-gif"),
      });

      const res = await app.inject({
        method: "POST",
        url: "/trainer/branding/logo",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": contentType,
        },
        payload,
      });

      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body).toMatchObject({ error: "VALIDATION_ERROR" });
    });

    it("returns 401 without auth token", async () => {
      const { payload, contentType } = createMultipartPayload({
        filename: "logo.jpg",
        mimetype: "image/jpeg",
        content: Buffer.from("fake-logo"),
      });

      const res = await app.inject({
        method: "POST",
        url: "/trainer/branding/logo",
        headers: { "content-type": contentType },
        payload,
      });

      expect(res.statusCode).toBe(401);
    });
  });

  // ─── GET /my/trainer-branding ──────────────────────────────────────────────

  describe("GET /my/trainer-branding", () => {
    it("returns null when student has no linked trainers", async () => {
      const { accessToken } = await createStudentWithToken();

      const res = await app.inject({
        method: "GET",
        url: "/my/trainer-branding",
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toBeNull();
    });

    it("returns trainer branding when student has a linked trainer with branding", async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { accessToken: studentToken, email: studentEmail } =
        await createStudentWithToken();

      // Trainer sets up branding
      await app.inject({
        method: "PUT",
        url: "/trainer/branding",
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: {
          primaryColor: "#FF5733",
          secondaryColor: "#33A1FF",
          welcomeMessage: "Welcome to my gym!",
        },
      });

      // Trainer links student
      await app.inject({
        method: "POST",
        url: "/trainer/students",
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: { email: studentEmail },
      });

      const res = await app.inject({
        method: "GET",
        url: "/my/trainer-branding",
        headers: { authorization: `Bearer ${studentToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).not.toBeNull();
      expect(body.branding).not.toBeNull();
      expect(body.branding.primaryColor).toBe("#FF5733");
      expect(body.branding.secondaryColor).toBe("#33A1FF");
      expect(body.branding.welcomeMessage).toBe("Welcome to my gym!");
    });

    it("returns branding with null fields when trainer is linked but has no branding", async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { accessToken: studentToken, email: studentEmail } =
        await createStudentWithToken();

      // Link student without setting up branding
      await app.inject({
        method: "POST",
        url: "/trainer/students",
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: { email: studentEmail },
      });

      const res = await app.inject({
        method: "GET",
        url: "/my/trainer-branding",
        headers: { authorization: `Bearer ${studentToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).not.toBeNull();
      expect(body.branding).toBeNull();
    });

    it("returns 401 without auth token", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/my/trainer-branding",
      });

      expect(res.statusCode).toBe(401);
    });
  });
});
