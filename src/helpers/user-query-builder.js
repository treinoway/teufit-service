import { USER_RELATION_CONFIGS } from '../constants/user-relations.js';

/**
 * Build Prisma select object for user queries with dynamic relation loading
 *
 * This function constructs a Prisma select configuration that always includes
 * base user fields and conditionally adds related entities based on the
 * includeRelations array.
 *
 * Relation configurations are centralized in USER_RELATION_CONFIGS to maintain
 * a single source of truth and prevent drift between validation and implementation.
 *
 * @param {string[]} includeRelations - Array of relation names to include (e.g., ['address', 'socials'])
 * @returns {Object} Prisma select configuration object
 *
 * @example
 * // No relations → only base fields
 * buildUserSelect([])
 * // => { id: true, email: true, ... }
 *
 * @example
 * // Include address
 * buildUserSelect(['address'])
 * // => { id: true, email: true, ..., address: { select: { ... } } }
 *
 * @example
 * // Include multiple relations
 * buildUserSelect(['address', 'socials', 'preferences'])
 * // => { id: true, email: true, ..., address: {...}, socials: {...}, preferences: {...} }
 */
export function buildUserSelect(includeRelations = []) {
  const select = {
    // Base user fields - always included
    id: true,
    email: true,
    roles: true,
    status: true,
    firstName: true,
    lastName: true,
    gender: true,
    birthDate: true,
    avatarUrl: true,
  };

  // Dynamically add relations from central configuration
  // This ensures we stay in sync with ALLOWED_USER_RELATIONS
  for (const relation of includeRelations) {
    if (USER_RELATION_CONFIGS[relation]) {
      select[relation] = USER_RELATION_CONFIGS[relation];
    }
  }

  return select;
}
