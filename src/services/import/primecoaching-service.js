import * as xlsx from 'xlsx';
import { AppError } from '../../errors/app-error.js';

const COLUMN_FULL_NAME = 'Nome completo';
const COLUMN_EMAIL = 'E-mail';
const COLUMN_PLAN = 'Plano contratado';
const COLUMN_STATUS = 'Status';
const COLUMN_EXPIRATION_DATE = 'Data de vencimento';
const COLUMN_DAYS_REMAINING = 'Dias restantes';
const COLUMN_ANAMNESIS = 'Anamnese';
const COLUMN_PHOTOS = 'Fotos';
const COLUMN_TRAINING = 'Treino';
const COLUMN_DIET = 'Dieta';
const COLUMN_CARDIO = 'Cardio';

/**
 * Splits a full name string into firstName (first token) and lastName (remaining tokens).
 * Exported for unit testing.
 */
export function splitFullName(fullName) {
  if (!fullName || typeof fullName !== 'string') {
    return { firstName: null, lastName: null };
  }

  const trimmed = fullName.trim();
  if (!trimmed) return { firstName: null, lastName: null };

  const parts = trimmed.split(/\s+/);
  const firstName = parts[0] ?? null;
  const lastName = parts.length > 1 ? parts.slice(1).join(' ') : null;

  return { firstName, lastName };
}

function parseXlsxBuffer(buffer) {
  const workbook = xlsx.read(buffer, { type: 'buffer' });
  const firstSheetName = workbook.SheetNames[0];

  if (!firstSheetName) {
    throw new AppError({
      httpStatus: 400,
      error: 'IMPORT_FORMAT_CHANGED',
      messageCode: 'import.primecoaching.formatChanged',
      message: 'The uploaded file contains no sheets',
    });
  }

  const sheet = workbook.Sheets[firstSheetName];
  return xlsx.utils.sheet_to_json(sheet);
}

function validateSheetRows(rows) {
  if (rows.length === 0) return;

  const firstRow = rows[0];
  const hasExpectedColumns =
    COLUMN_FULL_NAME in firstRow || COLUMN_EMAIL in firstRow;

  if (!hasExpectedColumns) {
    throw new AppError({
      httpStatus: 400,
      error: 'IMPORT_FORMAT_CHANGED',
      messageCode: 'import.primecoaching.formatChanged',
      message: 'The uploaded file does not match the expected PrimeCoaching export format',
    });
  }
}

function mapRowToStudent(row) {
  const fullName = row[COLUMN_FULL_NAME] ?? null;
  const rawEmail = row[COLUMN_EMAIL] ?? null;
  const email = rawEmail ? String(rawEmail).toLowerCase().trim() : null;
  const daysRemainingRaw = row[COLUMN_DAYS_REMAINING];

  const { firstName, lastName } = splitFullName(
    typeof fullName === 'string' ? fullName : null,
  );

  return {
    fullName: typeof fullName === 'string' ? fullName.trim() : null,
    firstName,
    lastName,
    email,
    plan: row[COLUMN_PLAN] ?? null,
    status: row[COLUMN_STATUS] ?? null,
    expirationDate: row[COLUMN_EXPIRATION_DATE] ?? null,
    daysRemaining:
      daysRemainingRaw != null ? parseFloat(daysRemainingRaw) : null,
    anamnesis: row[COLUMN_ANAMNESIS] ?? null,
    photos: row[COLUMN_PHOTOS] ?? null,
    training: row[COLUMN_TRAINING] ?? null,
    diet: row[COLUMN_DIET] ?? null,
    cardio: row[COLUMN_CARDIO] ?? null,
    duplicateEmail: false,
  };
}

function markDuplicateEmails(students) {
  const emailCount = new Map();

  for (const student of students) {
    if (!student.email) continue;
    emailCount.set(student.email, (emailCount.get(student.email) ?? 0) + 1);
  }

  return students.map((student) => ({
    ...student,
    duplicateEmail: student.email
      ? (emailCount.get(student.email) ?? 0) > 1
      : false,
  }));
}

function buildSummary(allStudents, studentsWithEmail) {
  const duplicateEmailsSet = new Set(
    studentsWithEmail
      .filter((s) => s.duplicateEmail)
      .map((s) => s.email),
  );

  return {
    total: allStudents.length,
    withEmail: studentsWithEmail.length,
    withoutEmail: allStudents.length - studentsWithEmail.length,
    duplicateEmails: duplicateEmailsSet.size,
  };
}

/**
 * Parses a PrimeCoaching active customers XLSX export from the provided buffer,
 * validates the format, maps rows to student objects, and returns a preview list
 * with a summary. Nothing is saved to the database.
 */
export function parseStudentsFromXlsx(buffer) {
  const rows = parseXlsxBuffer(buffer);

  validateSheetRows(rows);

  const allMapped = rows.map(mapRowToStudent);
  const allWithDuplicateFlags = markDuplicateEmails(allMapped);
  const studentsWithEmail = allWithDuplicateFlags.filter((s) => s.email);

  const summary = buildSummary(allWithDuplicateFlags, studentsWithEmail);

  return { students: studentsWithEmail, summary };
}
