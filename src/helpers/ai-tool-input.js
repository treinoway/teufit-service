const REF_TAG_PATTERN = /^\[[A-Z_]+:(.+)\]$/;

// Strips a [TYPE_REF:uuid] wrapper the model may copy from the context; raw ids and null pass through.
export function unwrapRefTag(value) {
  if (value == null) return value;
  const trimmed = String(value).trim();
  const match = REF_TAG_PATTERN.exec(trimmed);
  return match ? match[1] : trimmed;
}

// Strips ref-tag wrappers from every *Id and *Ids field at any depth (ids are raw UUIDs by contract).
export function sanitizeToolInputIds(input) {
  if (Array.isArray(input)) return input.map(sanitizeToolInputIds);
  if (!input || typeof input !== 'object') return input;
  const sanitized = { ...input };
  for (const key of Object.keys(sanitized)) {
    const value = sanitized[key];
    if (key.endsWith('Id') && typeof value === 'string') {
      sanitized[key] = unwrapRefTag(value);
    } else if (key.endsWith('Ids') && Array.isArray(value)) {
      sanitized[key] = value.map((item) => (typeof item === 'string' ? unwrapRefTag(item) : sanitizeToolInputIds(item)));
    } else if (value && typeof value === 'object') {
      sanitized[key] = sanitizeToolInputIds(value);
    }
  }
  return sanitized;
}
