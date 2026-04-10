import { describe, it, expect } from 'vitest';
import { i18nField, i18nArrayField } from '../../src/i18n/schema-helpers.js';

describe('i18nField', () => {
  it('returns both the raw field and the *Label sibling', () => {
    const result = i18nField('category', 'trainingCategory');
    expect(result).toHaveProperty('category');
    expect(result).toHaveProperty('categoryLabel');
  });

  it('annotates the raw field with x-i18n set to the namespace', () => {
    const { category } = i18nField('category', 'trainingCategory');
    expect(category['x-i18n']).toBe('trainingCategory');
  });

  it('sets type: string on both fields', () => {
    const { category, categoryLabel } = i18nField('category', 'trainingCategory');
    expect(category.type).toBe('string');
    expect(categoryLabel.type).toBe('string');
  });

  it('does not include nullable when extras.nullable is not set', () => {
    const { category, categoryLabel } = i18nField('category', 'trainingCategory');
    expect(category.nullable).toBeUndefined();
    expect(categoryLabel.nullable).toBeUndefined();
  });

  it('propagates nullable: true to both fields when extras.nullable is true', () => {
    const { bodySegment, bodySegmentLabel } = i18nField('bodySegment', 'bodySegment', { nullable: true });
    expect(bodySegment.nullable).toBe(true);
    expect(bodySegmentLabel.nullable).toBe(true);
  });

  it('does not include x-i18n on the *Label sibling', () => {
    const { categoryLabel } = i18nField('category', 'trainingCategory');
    expect(categoryLabel['x-i18n']).toBeUndefined();
  });

  it('works with arbitrary field names and namespaces', () => {
    const result = i18nField('weekDay', 'weekDay', { nullable: true });
    expect(result.weekDay['x-i18n']).toBe('weekDay');
    expect(result.weekDayLabel.type).toBe('string');
    expect(result.weekDayLabel.nullable).toBe(true);
  });
});

describe('i18nArrayField', () => {
  it('returns both the raw array field and the *Label sibling array', () => {
    const result = i18nArrayField('roles', 'userRole');
    expect(result).toHaveProperty('roles');
    expect(result).toHaveProperty('rolesLabel');
  });

  it('sets type: array on both fields', () => {
    const { roles, rolesLabel } = i18nArrayField('roles', 'userRole');
    expect(roles.type).toBe('array');
    expect(rolesLabel.type).toBe('array');
  });

  it('annotates array items with x-i18n on the raw field', () => {
    const { roles } = i18nArrayField('roles', 'userRole');
    expect(roles.items).toBeDefined();
    expect(roles.items['x-i18n']).toBe('userRole');
    expect(roles.items.type).toBe('string');
  });

  it('does not include x-i18n on the *Label sibling items', () => {
    const { rolesLabel } = i18nArrayField('roles', 'userRole');
    expect(rolesLabel.items).toBeDefined();
    expect(rolesLabel.items['x-i18n']).toBeUndefined();
    expect(rolesLabel.items.type).toBe('string');
  });

  it('propagates nullable: true to both array fields when extras.nullable is true', () => {
    const { roles, rolesLabel } = i18nArrayField('roles', 'userRole', { nullable: true });
    expect(roles.nullable).toBe(true);
    expect(rolesLabel.nullable).toBe(true);
  });

  it('does not include nullable without extras.nullable', () => {
    const { roles, rolesLabel } = i18nArrayField('roles', 'userRole');
    expect(roles.nullable).toBeUndefined();
    expect(rolesLabel.nullable).toBeUndefined();
  });
});
