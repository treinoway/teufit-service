export const SIGNED_FILE_ANNOTATION = 'x-signed-file-url';

const SIGNED_FILE_PATHS_SYMBOL = Symbol.for('treinoway.signedFilePaths');
const ARRAY_SEGMENT = '*';

/**
 * @typedef {Object} SignedFileDescriptor
 * @property {string[]} path - Segments to the object holding the key ('*' for array items)
 * @property {string} keyField - Property that stores the storage key
 * @property {string} urlField - Sibling property that receives the signed URL
 */

// Throws in non-production when an annotated key has no declared URL sibling in the schema.
function assertUrlSiblingDeclared(properties, keyField, urlField) {
  if (process.env.NODE_ENV === 'production' || properties[urlField]) return;
  throw new Error(
    `[signed-file] Schema field '${keyField}' declares '${SIGNED_FILE_ANNOTATION}' but is missing the '${urlField}' sibling property.`,
  );
}

// Recursively collects the annotated key fields of a response schema node.
function collectDescriptors(schemaNode, currentPath, collector) {
  if (!schemaNode || typeof schemaNode !== 'object') return;
  if (schemaNode.type === 'array' && schemaNode.items) {
    collectDescriptors(schemaNode.items, [...currentPath, ARRAY_SEGMENT], collector);
    return;
  }
  if (!schemaNode.properties) return;
  for (const [field, propertySchema] of Object.entries(schemaNode.properties)) {
    const urlField = propertySchema?.[SIGNED_FILE_ANNOTATION];
    if (urlField) {
      assertUrlSiblingDeclared(schemaNode.properties, field, urlField);
      collector.push({ path: currentPath, keyField: field, urlField });
    } else {
      collectDescriptors(propertySchema, [...currentPath, field], collector);
    }
  }
}

/**
 * Compile (and cache on the schema) the annotated key paths of a response schema.
 * @param {object} schema - Fastify response schema for one status code
 * @returns {SignedFileDescriptor[]}
 */
export function compileSignedFilePaths(schema) {
  if (schema[SIGNED_FILE_PATHS_SYMBOL]) return schema[SIGNED_FILE_PATHS_SYMBOL];
  const descriptors = [];
  collectDescriptors(schema, [], descriptors);
  schema[SIGNED_FILE_PATHS_SYMBOL] = descriptors;
  return descriptors;
}

// Collects every payload object reached by following the path segments.
function collectNodes(node, path, index, collector) {
  if (node == null || typeof node !== 'object') return;
  if (index === path.length) {
    collector.push(node);
    return;
  }
  const segment = path[index];
  if (segment === ARRAY_SEGMENT) {
    if (Array.isArray(node)) node.forEach((item) => collectNodes(item, path, index + 1, collector));
    return;
  }
  collectNodes(node[segment], path, index + 1, collector);
}

// Writes the signed URL sibling on one node that carries the key field.
async function writeUrl(node, { keyField, urlField }, resolveUrl) {
  if (!(keyField in node)) return;
  node[urlField] = await resolveUrl(node[keyField]);
}

/**
 * Write the signed-URL sibling next to every annotated storage key in the payload (in place).
 * @param {unknown} payload - Response payload
 * @param {object} schema - Fastify response schema for the current status code
 * @param {(key: string|null) => Promise<string|null>} resolveUrl - Maps a stored key to a URL (null when none)
 * @returns {Promise<void>}
 */
export async function applySignedFileUrls(payload, schema, resolveUrl) {
  const descriptors = compileSignedFilePaths(schema);
  const writes = [];
  for (const descriptor of descriptors) {
    const nodes = [];
    collectNodes(payload, descriptor.path, 0, nodes);
    nodes.forEach((node) => writes.push(writeUrl(node, descriptor, resolveUrl)));
  }
  await Promise.all(writes);
}
