/**
 * Public re-exports for the i18n module.
 */

export { SUPPORTED_LOCALES, DEFAULT_LOCALE, LANGUAGE_HEADER } from './constants.js';
export { resolveLanguage, getRequestLanguage, translate, translateTemplate } from './i18n-service.js';
export { compileI18nPaths, applyLabels } from './label-walker.js';
export { i18nField, i18nArrayField } from './schema-helpers.js';
