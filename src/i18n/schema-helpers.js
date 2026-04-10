/**
 * Schema annotation helpers for i18n.
 *
 * Use these helpers inside route response schemas to declare both the raw field
 * and the translated `*Label` sibling in one call. The `x-i18n` extension key
 * tells the label-walker which categorical namespace to use when populating
 * the sibling at response time.
 *
 * Example usage in a schema:
 *   properties: {
 *     id: { type: 'string' },
 *     ...i18nField('category', 'trainingCategory'),
 *     ...i18nField('bodySegment', 'bodySegment', { nullable: true }),
 *     ...i18nArrayField('roles', 'userRole'),
 *   }
 */

/**
 * Declare a single-value categorical field + its `*Label` sibling.
 *
 * @param {string} fieldName - The raw field name (e.g. 'category')
 * @param {string} namespace - Categorical namespace key (e.g. 'trainingCategory')
 * @param {{ nullable?: boolean }} [extras] - Extra schema properties applied to both fields
 * @returns {Record<string, object>} Object with two keys: `fieldName` and `${fieldName}Label`
 */
export function i18nField(fieldName, namespace, extras = {}) {
  const base = { type: 'string' };

  if (extras.nullable === true) {
    base.nullable = true;
  }

  return {
    [fieldName]: { ...base, 'x-i18n': namespace },
    [`${fieldName}Label`]: { ...base },
  };
}

/**
 * Declare an array-of-strings categorical field + its `*Label` sibling.
 * Useful for fields like `User.roles[]` where each element maps to a translated label.
 *
 * @param {string} fieldName - The raw field name (e.g. 'roles')
 * @param {string} namespace - Categorical namespace key applied to array items (e.g. 'userRole')
 * @param {{ nullable?: boolean }} [extras]
 * @returns {Record<string, object>} Object with two keys: `fieldName` and `${fieldName}Label`
 */
export function i18nArrayField(fieldName, namespace, extras = {}) {
  const arrayBase = { type: 'array' };

  if (extras.nullable === true) {
    arrayBase.nullable = true;
  }

  return {
    [fieldName]: { ...arrayBase, items: { type: 'string', 'x-i18n': namespace } },
    [`${fieldName}Label`]: { ...arrayBase, items: { type: 'string' } },
  };
}
