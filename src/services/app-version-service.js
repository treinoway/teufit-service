import { MobileAppEnv, mobilePlatformValues } from '../constants/mobile-app.js';

/**
 * Keeps a version field only when it is a non-empty string.
 */
function toStringOrNull(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Parses APP_MIN_VERSIONS, treating (and logging) a malformed value as empty so it never breaks boot or requests.
 *
 * @param {string|undefined} rawValue
 * @param {object} logger
 * @returns {Record<string, Record<string, { minVersion: string|null, storeUrl: string|null }>>}
 */
export function parseAppMinVersions(rawValue, logger) {
  if (!rawValue) return {};

  try {
    const parsed = JSON.parse(rawValue);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {
    logger.error(`app-version: ${MobileAppEnv.MIN_VERSIONS} is not valid JSON, ignoring it`);
    return {};
  }

  logger.error(`app-version: ${MobileAppEnv.MIN_VERSIONS} must be a JSON object, ignoring it`);
  return {};
}

/**
 * Resolves the minimum version and store url for an app/platform, with nulls when not configured.
 *
 * @param {object} minVersions - Result of parseAppMinVersions
 * @param {{ appId: string, platform: string }} query
 * @returns {{ appId: string, platform: string, minVersion: string|null, storeUrl: string|null }}
 */
export function resolveAppMinVersion(minVersions, { appId, platform }) {
  const appEntry = Object.hasOwn(minVersions, appId) ? minVersions[appId] : null;
  const entry = mobilePlatformValues.includes(platform) ? appEntry?.[platform] : null;

  return {
    appId,
    platform,
    minVersion: toStringOrNull(entry?.minVersion),
    storeUrl: toStringOrNull(entry?.storeUrl),
  };
}
