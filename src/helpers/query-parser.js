/**
 * Parse and validate include relations from query parameter
 *
 * This function takes a comma-separated string of relation names from the ?include
 * query parameter and validates them against a whitelist of allowed relations.
 *
 * @param {string|undefined} includeParam - Raw query parameter value (e.g., "address,socials")
 * @param {Set<string>} allowedRelations - Set of allowed relation names
 * @returns {{ relations: string[], invalid: string[] }} Object with valid and invalid relations
 *
 * @example
 * // No parameter → empty array (minimal payload)
 * parseIncludeParameter(undefined, allowedSet)
 * // => { relations: [], invalid: [] }
 *
 * @example
 * // Empty string → empty array (explicit minimal payload)
 * parseIncludeParameter('', allowedSet)
 * // => { relations: [], invalid: [] }
 *
 * @example
 * // Single relation
 * parseIncludeParameter('address', allowedSet)
 * // => { relations: ['address'], invalid: [] }
 *
 * @example
 * // Multiple valid relations
 * parseIncludeParameter('address,socials', allowedSet)
 * // => { relations: ['address', 'socials'], invalid: [] }
 *
 * @example
 * // Mixed valid and invalid relations
 * parseIncludeParameter('address,accounts', allowedSet)
 * // => { relations: ['address'], invalid: ['accounts'] }
 */
export function parseIncludeParameter(includeParam, allowedRelations) {
  // No parameter or empty string → return empty array
  if (includeParam === undefined || includeParam === '') {
    return { relations: [], invalid: [] };
  }

  // Parse comma-separated values
  const requested = includeParam
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean);

  // Validate against whitelist
  const valid = [];
  const invalid = [];

  for (const relation of requested) {
    if (allowedRelations.has(relation)) {
      valid.push(relation);
    } else {
      invalid.push(relation);
    }
  }

  // Remove duplicates using Set
  return {
    relations: [...new Set(valid)],
    invalid: [...new Set(invalid)],
  };
}
