/**
 * label-walker.js
 *
 * IMPLEMENTATION PATH: Plan A (native x-i18n preservation).
 * Smoke test confirmed that Fastify 5.7 preserves custom `x-*` extension keys
 * on route response schemas at runtime via `request.routeOptions.schema.response`.
 * No side-map via `onRoute` hook is needed.
 *
 * This module:
 *  1. `compileI18nPaths(schema)` — recursively walks a JSON-Schema object and
 *     produces a flat list of path descriptors for fields annotated with `x-i18n`.
 *     The result is cached on the schema object via a Symbol so the walk runs
 *     once per route.
 *  2. `applyLabels(payload, schema, language)` — iterates the cached path list
 *     and writes translated `*Label` siblings into the response payload.
 */

import { translate } from './i18n-service.js';

const I18N_PATHS_SYMBOL = Symbol.for('treinoway.i18nPaths');

/**
 * @typedef {Object} I18nPathDescriptor
 * @property {string[]} path - Path segments, '*' for array items (e.g. ['trainings', '*', 'category'])
 * @property {string} namespace - Categorical namespace (e.g. 'trainingCategory')
 * @property {boolean} isArray - True when the field itself is an array of strings
 * @property {boolean} nullable - True when the field can be null
 */

/**
 * Compile the list of i18n-annotated paths for a response schema.
 * Result is cached on the schema object via Symbol to avoid repeated traversals.
 *
 * Dev-mode guardrail: throws when a field declares `x-i18n` but the corresponding
 * `*Label` sibling is missing from the schema properties. This catches schema/walker
 * drift immediately during development.
 *
 * @param {object} schema - Fastify JSON-Schema response schema object
 * @returns {{ hasI18n: boolean, paths: I18nPathDescriptor[] }}
 */
export function compileI18nPaths(schema) {
  if (schema[I18N_PATHS_SYMBOL]) {
    return schema[I18N_PATHS_SYMBOL];
  }

  const paths = [];
  walkSchema(schema, [], paths);

  const result = { hasI18n: paths.length > 0, paths };
  schema[I18N_PATHS_SYMBOL] = result;
  return result;
}

/**
 * Apply translated label siblings to the response payload in place.
 * Does nothing when the schema has no i18n-annotated paths.
 *
 * @param {unknown} payload - The response payload (mutated in place)
 * @param {object} schema - The Fastify response schema for the current status code
 * @param {string} language - Resolved locale tag (e.g. 'pt-BR')
 */
export function applyLabels(payload, schema, language) {
  if (payload == null) return;

  const { hasI18n, paths } = compileI18nPaths(schema);
  if (!hasI18n) return;

  for (const descriptor of paths) {
    applyPathDescriptor(payload, descriptor, language);
  }
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Recursively walk a schema node, collecting i18n path descriptors.
 *
 * @param {object} schemaNode
 * @param {string[]} currentPath - Accumulated path segments
 * @param {I18nPathDescriptor[]} collector
 */
function walkSchema(schemaNode, currentPath, collector) {
  if (!schemaNode || typeof schemaNode !== 'object') return;

  const { type, properties, items } = schemaNode;

  if (type === 'object' && properties) {
    for (const [key, propSchema] of Object.entries(properties)) {
      const childPath = [...currentPath, key];

      if (propSchema['x-i18n']) {
        const namespace = propSchema['x-i18n'];
        const labelKey = `${key}Label`;

        // Dev-mode guardrail: *Label sibling must be declared in the schema
        if (process.env.NODE_ENV !== 'production') {
          if (!properties[labelKey]) {
            throw new Error(
              `[i18n] Schema declares 'x-i18n' on field '${key}' but is missing the '${labelKey}' sibling property. ` +
              `Use i18nField('${key}', '${namespace}') to declare both at once.`
            );
          }
        }

        collector.push({
          path: childPath,
          namespace,
          isArray: false,
          nullable: Boolean(propSchema.nullable),
        });
      } else if (propSchema.type === 'array' && propSchema.items?.['x-i18n']) {
        // Array-of-strings case (e.g. roles)
        const namespace = propSchema.items['x-i18n'];
        const labelKey = `${key}Label`;

        if (process.env.NODE_ENV !== 'production') {
          if (!properties[labelKey]) {
            throw new Error(
              `[i18n] Schema declares 'x-i18n' on array items of field '${key}' but is missing the '${labelKey}' sibling property. ` +
              `Use i18nArrayField('${key}', '${namespace}') to declare both at once.`
            );
          }
        }

        collector.push({
          path: childPath,
          namespace,
          isArray: true,
          nullable: Boolean(propSchema.nullable),
        });
      } else if (propSchema.type === 'object' && propSchema.properties) {
        // Recurse into nested objects
        walkSchema(propSchema, childPath, collector);
      } else if (propSchema.type === 'array' && propSchema.items) {
        // Recurse into array-of-objects
        walkSchema(propSchema.items, [...childPath, '*'], collector);
      }
    }
  } else if (type === 'array' && items) {
    walkSchema(items, [...currentPath, '*'], collector);
  }
}

/**
 * Traverse the live payload following the path descriptor and write the
 * translated label sibling(s).
 *
 * @param {unknown} payload
 * @param {I18nPathDescriptor} descriptor
 * @param {string} language
 */
function applyPathDescriptor(payload, descriptor, language) {
  const { path, namespace, isArray } = descriptor;
  applyAtPath(payload, path, 0, namespace, isArray, language);
}

/**
 * Recursive traversal of the payload along the path segments.
 *
 * @param {unknown} node - Current payload node
 * @param {string[]} path - Remaining path segments
 * @param {number} index - Current segment index
 * @param {string} namespace
 * @param {boolean} isArray
 * @param {string} language
 */
function applyAtPath(node, path, index, namespace, isArray, language) {
  if (node == null || typeof node !== 'object') return;

  const segment = path[index];
  const isLast = index === path.length - 1;

  if (segment === '*') {
    if (!Array.isArray(node)) return;
    for (const item of node) {
      applyAtPath(item, path, index + 1, namespace, isArray, language);
    }
    return;
  }

  if (isLast) {
    const fieldName = segment;
    const labelKey = `${fieldName}Label`;

    if (!(fieldName in node)) return; // Field not present — skip

    const rawValue = node[fieldName];

    if (rawValue === null) {
      node[labelKey] = null;
      return;
    }

    if (isArray) {
      if (!Array.isArray(rawValue)) return;
      node[labelKey] = rawValue.map((item) =>
        translate(`categorical.${namespace}`, item, language, { fallbackValue: item })
      );
    } else {
      node[labelKey] = translate(`categorical.${namespace}`, rawValue, language, { fallbackValue: rawValue });
    }

    return;
  }

  applyAtPath(node[segment], path, index + 1, namespace, isArray, language);
}
