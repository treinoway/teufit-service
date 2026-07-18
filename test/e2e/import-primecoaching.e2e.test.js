import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from 'vitest';
import * as xlsx from 'xlsx';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';

// Mock the service so no real XLSX parsing is needed for most tests.
vi.mock('../../src/services/import/primecoaching-service.js', () => ({
  parseStudentsFromXlsx: vi.fn(),
  splitFullName: vi.fn((name) => {
    if (!name) return { firstName: null, lastName: null };
    const parts = name.trim().split(/\s+/);
    return { firstName: parts[0], lastName: parts.slice(1).join(' ') || null };
  }),
}));

import { parseStudentsFromXlsx } from '../../src/services/import/primecoaching-service.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MULTIPART_BOUNDARY = 'WebKitFormBoundary7MA4YWxkTrZu0gW';
const MULTIPART_CONTENT_TYPE = `multipart/form-data; boundary=${MULTIPART_BOUNDARY}`;

function buildMinimalXlsxBuffer() {
  const workbook = xlsx.utils.book_new();
  const sheet = xlsx.utils.aoa_to_sheet([
    ['Nome completo', 'E-mail'],
    ['Test User', 'test@example.com'],
  ]);
  xlsx.utils.book_append_sheet(workbook, sheet, 'Sheet1');
  const raw = xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
}

function buildMultipartPayload({ filename, mimetype, content }) {
  const parts = [];
  parts.push(`--${MULTIPART_BOUNDARY}`);
  parts.push(`Content-Disposition: form-data; name="file"; filename="${filename}"`);
  parts.push(`Content-Type: ${mimetype}`);
  parts.push('');
  parts.push(content.toString('binary'));
  parts.push(`--${MULTIPART_BOUNDARY}--`);

  return {
    payload: parts.join('\r\n'),
    contentType: MULTIPART_CONTENT_TYPE,
  };
}

function buildXlsxMultipartPayload() {
  return buildMultipartPayload({
    filename: 'students.xlsx',
    mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    content: buildMinimalXlsxBuffer(),
  });
}

e2eDescribe('e2e: POST /trainer/import/primecoaching/preview', () => {
  let app;

  beforeAll(async () => {
    app = await setupApp();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(async () => {
    await cleanDatabase();
    vi.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // Helper: create a trainer account and return a valid access token
  // ---------------------------------------------------------------------------
  async function createTrainerWithToken() {
    const email = `e2e+trainer-${Date.now()}@example.com`;
    const password = 'StrongPassw0rd!';

    const signupRes = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { email, password },
    });
    expect(signupRes.statusCode).toBe(201);
    const { token: { accessToken } } = signupRes.json();

    const becomeRes = await app.inject({
      method: 'PATCH',
      url: '/become-trainer',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(becomeRes.statusCode).toBe(200);

    return { accessToken: becomeRes.json().token.accessToken };
  }

  // ---------------------------------------------------------------------------
  // Helper: create a regular student account and return a valid access token
  // ---------------------------------------------------------------------------
  async function createStudentWithToken() {
    const email = `e2e+student-${Date.now()}@example.com`;
    const password = 'StrongPassw0rd!';

    const signupRes = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { email, password },
    });
    expect(signupRes.statusCode).toBe(201);
    return { accessToken: signupRes.json().token.accessToken };
  }

  // ---------------------------------------------------------------------------
  // Auth
  // ---------------------------------------------------------------------------
  describe('authentication', () => {
    it('returns 401 when no authorization token is provided', async () => {
      const { payload, contentType } = buildXlsxMultipartPayload();

      const res = await app.inject({
        method: 'POST',
        url: '/trainer/import/primecoaching/preview',
        headers: { 'content-type': contentType },
        payload,
      });

      expect(res.statusCode).toBe(401);
    });

    it('returns 403 when authenticated as a student (not a trainer)', async () => {
      const { accessToken } = await createStudentWithToken();
      const { payload, contentType } = buildXlsxMultipartPayload();

      const res = await app.inject({
        method: 'POST',
        url: '/trainer/import/primecoaching/preview',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': contentType,
        },
        payload,
      });

      expect(res.statusCode).toBe(403);
    });
  });

  // ---------------------------------------------------------------------------
  // Validation
  // ---------------------------------------------------------------------------
  describe('request validation', () => {
    it('returns 400 when no file is provided', async () => {
      const { accessToken } = await createTrainerWithToken();

      const res = await app.inject({
        method: 'POST',
        url: '/trainer/import/primecoaching/preview',
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({
        error: 'VALIDATION_ERROR',
        messageCode: 'validation.failed',
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Success
  // ---------------------------------------------------------------------------
  describe('success path', () => {
    it('returns 200 with students array and summary when service succeeds', async () => {
      const { accessToken } = await createTrainerWithToken();

      const mockResult = {
        students: [
          {
            fullName: 'Nicolle Costa',
            firstName: 'Nicolle',
            lastName: 'Costa',
            email: 'nicolle@example.com',
            plan: 'Semestral',
            status: 'Entregue',
            expirationDate: '01/10/2026',
            daysRemaining: 190,
            anamnesis: 'Enviado',
            photos: 'Enviado',
            training: 'Prescrito',
            diet: 'Prescrito',
            cardio: 'Prescrito',
            duplicateEmail: false,
          },
        ],
        summary: {
          total: 1,
          withEmail: 1,
          withoutEmail: 0,
          duplicateEmails: 0,
        },
      };

      parseStudentsFromXlsx.mockReturnValueOnce(mockResult);

      const { payload, contentType } = buildXlsxMultipartPayload();

      const res = await app.inject({
        method: 'POST',
        url: '/trainer/import/primecoaching/preview',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': contentType,
        },
        payload,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toHaveProperty('students');
      expect(body).toHaveProperty('summary');
      expect(body.students).toHaveLength(1);
      expect(body.students[0]).toMatchObject({
        firstName: 'Nicolle',
        lastName: 'Costa',
        email: 'nicolle@example.com',
        duplicateEmail: false,
      });
      expect(body.summary).toMatchObject({
        total: 1,
        withEmail: 1,
        withoutEmail: 0,
        duplicateEmails: 0,
      });
    });

    it('calls parseStudentsFromXlsx with the uploaded file buffer', async () => {
      const { accessToken } = await createTrainerWithToken();

      parseStudentsFromXlsx.mockReturnValueOnce({
        students: [],
        summary: { total: 0, withEmail: 0, withoutEmail: 0, duplicateEmails: 0 },
      });

      const { payload, contentType } = buildXlsxMultipartPayload();

      await app.inject({
        method: 'POST',
        url: '/trainer/import/primecoaching/preview',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': contentType,
        },
        payload,
      });

      expect(parseStudentsFromXlsx).toHaveBeenCalledTimes(1);
      const [calledBuffer] = parseStudentsFromXlsx.mock.calls[0];
      expect(Buffer.isBuffer(calledBuffer)).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Format error propagation
  // ---------------------------------------------------------------------------
  describe('format errors', () => {
    it('returns 400 with IMPORT_FORMAT_CHANGED when the file has unrecognised columns', async () => {
      const { accessToken } = await createTrainerWithToken();

      const { AppError } = await import('../../src/errors/app-error.js');
      parseStudentsFromXlsx.mockImplementationOnce(() => {
        throw new AppError({
          httpStatus: 400,
          error: 'IMPORT_FORMAT_CHANGED',
          messageCode: 'import.primecoaching.formatChanged',
          message: 'The uploaded file does not match the expected PrimeCoaching export format',
        });
      });

      const { payload, contentType } = buildXlsxMultipartPayload();

      const res = await app.inject({
        method: 'POST',
        url: '/trainer/import/primecoaching/preview',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': contentType,
        },
        payload,
      });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({
        error: 'IMPORT_FORMAT_CHANGED',
        messageCode: 'import.primecoaching.formatChanged',
      });
    });
  });
});
