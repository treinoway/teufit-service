import { describe, it, expect } from 'vitest';
import * as xlsx from 'xlsx';

import {
  splitFullName,
  parseStudentsFromXlsx,
} from '../../src/services/import/primecoaching-service.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildXlsxBuffer(rows) {
  const header = [
    'Nome completo',
    'E-mail',
    'Plano contratado',
    'Status',
    'Data de vencimento',
    'Dias restantes',
    'Anamnese',
    'Fotos',
    'Treino',
    'Dieta',
    'Cardio',
  ];

  const sheetData = [header, ...rows.map((r) => header.map((col) => r[col] ?? ''))];
  const workbook = xlsx.utils.book_new();
  const sheet = xlsx.utils.aoa_to_sheet(sheetData);
  xlsx.utils.book_append_sheet(workbook, sheet, 'Sheet1');

  const buffer = xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  return Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

// ---------------------------------------------------------------------------
// splitFullName
// ---------------------------------------------------------------------------

describe('splitFullName', () => {
  it('splits a two-part name into firstName and lastName', () => {
    expect(splitFullName('Nicolle Costa')).toEqual({
      firstName: 'Nicolle',
      lastName: 'Costa',
    });
  });

  it('splits a multi-part name — first word is firstName, rest is lastName', () => {
    expect(splitFullName('Maria Clara de Souza')).toEqual({
      firstName: 'Maria',
      lastName: 'Clara de Souza',
    });
  });

  it('returns null lastName for a single-word name', () => {
    expect(splitFullName('Madonna')).toEqual({
      firstName: 'Madonna',
      lastName: null,
    });
  });

  it('returns both fields as null for a null input', () => {
    expect(splitFullName(null)).toEqual({ firstName: null, lastName: null });
  });

  it('returns both fields as null for an empty string', () => {
    expect(splitFullName('')).toEqual({ firstName: null, lastName: null });
  });

  it('returns both fields as null for a non-string input', () => {
    expect(splitFullName(42)).toEqual({ firstName: null, lastName: null });
  });

  it('handles leading/trailing whitespace gracefully', () => {
    expect(splitFullName('  João Silva  ')).toEqual({
      firstName: 'João',
      lastName: 'Silva',
    });
  });

  it('returns both fields as null for whitespace-only string', () => {
    expect(splitFullName('   ')).toEqual({ firstName: null, lastName: null });
  });
});

// ---------------------------------------------------------------------------
// parseStudentsFromXlsx
// ---------------------------------------------------------------------------

describe('parseStudentsFromXlsx', () => {
  describe('happy path', () => {
    it('returns mapped students and correct summary', () => {
      const rows = [
        {
          'Nome completo': 'Nicolle Costa',
          'E-mail': 'nicolle@example.com',
          'Plano contratado': 'Semestral',
          Status: 'Entregue',
          'Data de vencimento': '01/10/2026',
          'Dias restantes': '190.0',
          Anamnese: 'Enviado',
          Fotos: 'Enviado',
          Treino: 'Prescrito',
          Dieta: 'Prescrito',
          Cardio: 'Prescrito',
        },
        {
          'Nome completo': 'Carlos Silva',
          'E-mail': 'carlos@example.com',
          'Plano contratado': 'Mensal',
          Status: 'Ativo',
          'Data de vencimento': '01/04/2026',
          'Dias restantes': '7.0',
        },
      ];

      const result = parseStudentsFromXlsx(buildXlsxBuffer(rows));

      expect(result.summary).toEqual({
        total: 2,
        withEmail: 2,
        withoutEmail: 0,
        duplicateEmails: 0,
      });

      expect(result.students).toHaveLength(2);
      const [first] = result.students;
      expect(first.firstName).toBe('Nicolle');
      expect(first.lastName).toBe('Costa');
      expect(first.email).toBe('nicolle@example.com');
      expect(first.plan).toBe('Semestral');
      expect(first.daysRemaining).toBe(190);
      expect(first.duplicateEmail).toBe(false);
    });

    it('lowercases and trims email addresses', () => {
      const rows = [
        { 'Nome completo': 'Test User', 'E-mail': '  UPPER@EXAMPLE.COM  ' },
      ];

      const { students } = parseStudentsFromXlsx(buildXlsxBuffer(rows));

      expect(students[0].email).toBe('upper@example.com');
    });

    it('excludes rows without email from students but counts them in summary', () => {
      const rows = [
        { 'Nome completo': 'Has Email', 'E-mail': 'has@example.com' },
        { 'Nome completo': 'No Email', 'E-mail': '' },
      ];

      const { students, summary } = parseStudentsFromXlsx(buildXlsxBuffer(rows));

      expect(students).toHaveLength(1);
      expect(students[0].email).toBe('has@example.com');
      expect(summary.total).toBe(2);
      expect(summary.withEmail).toBe(1);
      expect(summary.withoutEmail).toBe(1);
    });

    it('returns an empty students list for an empty sheet', () => {
      const { students, summary } = parseStudentsFromXlsx(buildXlsxBuffer([]));

      expect(students).toHaveLength(0);
      expect(summary).toEqual({
        total: 0,
        withEmail: 0,
        withoutEmail: 0,
        duplicateEmails: 0,
      });
    });
  });

  describe('duplicate email detection', () => {
    it('marks rows with duplicateEmail: true when they share the same email', () => {
      const rows = [
        { 'Nome completo': 'Alice', 'E-mail': 'dupe@example.com' },
        { 'Nome completo': 'Bob', 'E-mail': 'dupe@example.com' },
      ];

      const { students, summary } = parseStudentsFromXlsx(buildXlsxBuffer(rows));

      expect(students).toHaveLength(2);
      expect(students[0].duplicateEmail).toBe(true);
      expect(students[1].duplicateEmail).toBe(true);
      expect(summary.duplicateEmails).toBe(1);
    });

    it('does not flag students with unique emails as duplicates', () => {
      const rows = [
        { 'Nome completo': 'Alice', 'E-mail': 'alice@example.com' },
        { 'Nome completo': 'Bob', 'E-mail': 'bob@example.com' },
      ];

      const { students } = parseStudentsFromXlsx(buildXlsxBuffer(rows));

      expect(students[0].duplicateEmail).toBe(false);
      expect(students[1].duplicateEmail).toBe(false);
    });
  });

  describe('format validation', () => {
    it('throws IMPORT_FORMAT_CHANGED when columns are unrecognised', () => {
      const workbook = xlsx.utils.book_new();
      const sheet = xlsx.utils.aoa_to_sheet([
        ['Col A', 'Col B'],
        ['foo', 'bar'],
      ]);
      xlsx.utils.book_append_sheet(workbook, sheet, 'Sheet1');
      const raw = xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx' });
      const buffer = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);

      expect(() => parseStudentsFromXlsx(buffer)).toThrow(
        expect.objectContaining({
          error: 'IMPORT_FORMAT_CHANGED',
          messageCode: 'import.primecoaching.formatChanged',
          httpStatus: 400,
        }),
      );
    });

  });
});
