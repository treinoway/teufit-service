/**
 * Central configuration for user relations that can be loaded via API
 * Each key defines a relation name and its corresponding Prisma select structure
 *
 * This is the single source of truth for user relations. Adding a new relation
 * only requires updating this object - ALLOWED_USER_RELATIONS is automatically
 * derived from its keys.
 */
export const USER_RELATION_CONFIGS = {
  address: {
    select: {
      id: true,
      line1: true,
      line2: true,
      neighborhood: true,
      city: true,
      state: true,
      stateCode: true,
      country: true,
      countryCode: true,
      postalCode: true,
    },
  },
  socials: {
    select: {
      id: true,
      instagram: true,
      whatsapp: true,
      x: true,
      threads: true,
      youtube: true,
      linkedin: true,
      facebook: true,
    },
  },
  preferences: {
    select: {
      activeProfile: true,
      rawPreferences: true,
    },
  },
};

/**
 * Derived from USER_RELATION_CONFIGS keys, plus virtual aliases that are
 * handled with custom logic in buildUserSelect rather than a direct Prisma
 * relation config.
 *
 * Set of allowed relations that can be requested via ?include query parameter.
 * These relations are safe to expose and don't contain sensitive information.
 */
export const ALLOWED_USER_RELATIONS = new Set([
  ...Object.keys(USER_RELATION_CONFIGS),
  'trainerOnboarding',
]);

/**
 * Relations that should never be exposed via the API
 * These contain sensitive security tokens and should only be accessed internally
 */
export const BLOCKED_USER_RELATIONS = [
  'accounts',
  'refreshTokens',
  'passwordResetTokens',
];
