import { describe, it, expect } from 'vitest';
import { computeAge, buildSheet, toNumber } from '../../src/helpers/nutrition-sheet.js';
import { Sex } from '../../src/constants/nutrition.js';

const NOW = new Date('2026-11-02T12:00:00.000Z');
const LEAN_MASS_REFERENCE_KG = 47.52;

describe('toNumber', () => {
  it('should keep null and undefined as null', () => {
    expect(toNumber(null)).toBeNull();
    expect(toNumber(undefined)).toBeNull();
  });

  it('should convert decimal-like values to numbers', () => {
    expect(toNumber('66.5')).toBe(66.5);
  });
});

describe('computeAge', () => {
  it('should return null without a birth date', () => {
    expect(computeAge(null, NOW)).toBeNull();
  });

  it('should count the year when the birthday already happened', () => {
    expect(computeAge(new Date('1997-03-10T00:00:00.000Z'), NOW)).toBe(29);
  });

  it('should not count the year when the birthday is not reached yet', () => {
    expect(computeAge(new Date('1997-12-25T00:00:00.000Z'), NOW)).toBe(28);
  });

  it('should count the year on the birthday itself', () => {
    expect(computeAge(new Date('1997-11-02T00:00:00.000Z'), NOW)).toBe(29);
  });

  it('should not count the year the day before the birthday', () => {
    expect(computeAge(new Date('1997-11-03T00:00:00.000Z'), NOW)).toBe(28);
  });
});

describe('buildSheet', () => {
  const user = { gender: Sex.FEMALE, birthDate: new Date('1997-03-10T00:00:00.000Z') };

  it('should prefill the measurements from the health detail when there is no saved profile', () => {
    const sheet = buildSheet({ user, healthDetail: { weight: 66, height: 165, bodyFat: 28 }, profile: null });

    expect(sheet).toMatchObject({
      sex: Sex.FEMALE,
      birthDate: '1997-03-10',
      weightKg: 66,
      heightCm: 165,
      bodyFatPct: 28,
      assessedAt: null,
    });
  });

  it('should compute lean mass from weight and body fat', () => {
    const sheet = buildSheet({ user, healthDetail: { weight: 66, height: 165, bodyFat: 28 }, profile: null });

    expect(sheet.leanMassKg).toBe(LEAN_MASS_REFERENCE_KG);
  });

  it('should leave lean mass null without body fat', () => {
    const sheet = buildSheet({ user, healthDetail: { weight: 66, height: 165, bodyFat: null }, profile: null });

    expect(sheet.leanMassKg).toBeNull();
  });

  it('should return null measurements without health detail', () => {
    const sheet = buildSheet({ user, healthDetail: null, profile: null });

    expect(sheet).toMatchObject({ weightKg: null, heightCm: null, bodyFatPct: null, leanMassKg: null });
  });

  it('should set sex to null when the user gender is not a valid sex', () => {
    const sheet = buildSheet({ user: { ...user, gender: 'other' }, healthDetail: null, profile: null });

    expect(sheet.sex).toBeNull();
  });

  it('should use the saved profile instead of the health detail', () => {
    const profile = {
      sex: Sex.MALE,
      weightKg: '80.5',
      heightCm: '180',
      bodyFatPct: '20',
      assessedAt: new Date('2026-10-15T00:00:00.000Z'),
    };

    const sheet = buildSheet({ user, healthDetail: { weight: 66, height: 165, bodyFat: 28 }, profile });

    expect(sheet).toMatchObject({
      sex: Sex.MALE,
      weightKg: 80.5,
      heightCm: 180,
      bodyFatPct: 20,
      leanMassKg: 64.4,
      assessedAt: '2026-10-15',
    });
  });

  it('should keep the birth date and age coming from the user when a profile exists', () => {
    const profile = { sex: Sex.FEMALE, weightKg: 60, heightCm: 160, bodyFatPct: null, assessedAt: new Date('2026-10-15') };

    const sheet = buildSheet({ user, healthDetail: null, profile });

    expect(sheet.birthDate).toBe('1997-03-10');
    expect(sheet.age).toBe(computeAge(user.birthDate));
  });

  it('should return null birth date and age without a birth date', () => {
    const sheet = buildSheet({ user: { gender: Sex.FEMALE, birthDate: null }, healthDetail: null, profile: null });

    expect(sheet).toMatchObject({ birthDate: null, age: null });
  });
});
