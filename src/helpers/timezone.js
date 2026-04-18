const DEFAULT_TIMEZONE = 'America/Sao_Paulo';

/**
 * Resolves an IANA timezone string from a header value.
 * Mirrors the never-400 semantics of resolveLanguage:
 * invalid or missing values silently fall back to America/Sao_Paulo.
 *
 * @param {string | undefined} header - Value of the app-timezone header
 * @param {{ fallback?: string }} [options]
 * @returns {string} Valid IANA timezone string
 */
export function resolveTimeZone(header, { fallback = DEFAULT_TIMEZONE } = {}) {
  if (!header || typeof header !== 'string') return fallback;

  try {
    Intl.DateTimeFormat(undefined, { timeZone: header });
    return header;
  } catch {
    return fallback;
  }
}
