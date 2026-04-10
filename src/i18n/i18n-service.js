import { SUPPORTED_LOCALES, DEFAULT_LOCALE } from "./constants.js";
import ptBR from "./locales/pt-BR.js";
import enUS from "./locales/en-US.js";

const locales = {
  "pt-BR": ptBR,
  "en-US": enUS,
};

const SHORT_TAG_MAP = {
  en: "en-US",
  pt: "pt-BR",
};

/**
 * Normalize a raw `app-language` header value to a supported locale tag.
 * Accepts BCP-47 variants like `en-US`, short tags like `en`, and comma-separated
 * values like `en-US,en;q=0.9`. Unknown or missing values silently fall back to
 * the DEFAULT_LOCALE.
 *
 * @param {string | undefined} raw - Raw header value
 * @returns {string} Resolved locale tag (e.g. 'pt-BR', 'en-US')
 */
export function resolveLanguage(raw) {
  if (!raw || typeof raw !== "string") return DEFAULT_LOCALE;

  // Take only the first token (defensive against Accept-Language multi-value syntax)
  const firstToken = raw.split(",")[0].trim();

  // Normalize to canonical casing: first segment lower, second segment upper
  const parts = firstToken.split("-");
  const normalized =
    parts.length >= 2
      ? `${parts[0].toLowerCase()}-${parts[1].toUpperCase()}`
      : parts[0].toLowerCase();

  // Map short tags to full locales
  if (SHORT_TAG_MAP[normalized]) {
    return SHORT_TAG_MAP[normalized];
  }

  // Validate against supported locales
  if (SUPPORTED_LOCALES.includes(normalized)) {
    return normalized;
  }

  return DEFAULT_LOCALE;
}

/**
 * Read the resolved language from an incoming Fastify request.
 * Assumes `languageOnRequestHook` has already decorated `request.language`.
 *
 * @param {import('fastify').FastifyRequest} request
 * @returns {string}
 */
export function getRequestLanguage(request) {
  return request.language ?? DEFAULT_LOCALE;
}

/**
 * Translate a key within a given namespace for the requested language.
 * Fallback chain: locales[language][namespace][key] → pt-BR → fallbackValue → key.
 *
 * @param {string} namespace - Top-level namespace (e.g. 'errors', 'categorical.trainingCategory')
 * @param {string} key - The message key
 * @param {string} language - Resolved locale tag
 * @param {{ fallbackValue?: string }} [options]
 * @returns {string}
 */
export function translate(namespace, key, language, { fallbackValue } = {}) {
  const resolved =
    resolveNamespace(locales[language], namespace)?.[key] ??
    resolveNamespace(locales[DEFAULT_LOCALE], namespace)?.[key] ??
    fallbackValue ??
    key;
  return resolved;
}

/**
 * Translate a template string for a given key, then substitute `{placeholder}`
 * tokens with values from the `vars` object. Array values are joined with ', '.
 *
 * @param {string} namespace
 * @param {string} key
 * @param {string} language
 * @param {Record<string, unknown>} vars
 * @returns {string}
 */
export function translateTemplate(namespace, key, language, vars) {
  const template = translate(namespace, key, language, {
    fallbackValue: undefined,
  });

  if (!template || template === key) {
    return key;
  }

  return template.replace(/\{(\w+)\}/g, (match, placeholder) => {
    if (!(placeholder in vars)) return match;
    const value = vars[placeholder];
    if (Array.isArray(value)) return value.join(", ");
    return String(value);
  });
}

/**
 * Resolve a potentially nested namespace path like 'categorical.trainingCategory'
 * into the corresponding nested object within a locale root.
 *
 * @param {object | undefined} localeRoot
 * @param {string} namespace - Dot-separated path
 * @returns {object | undefined}
 */
function resolveNamespace(localeRoot, namespace) {
  if (!localeRoot) return undefined;
  const parts = namespace.split(".");
  let current = localeRoot;
  for (const part of parts) {
    if (!current || typeof current !== "object") return undefined;
    current = current[part];
  }
  return current;
}
