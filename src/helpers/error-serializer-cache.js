const ERROR_STATUS_PATTERN = /^[45]/;

/**
 * Wraps Fastify's default response serializer factory so every 4xx/5xx
 * response schema is compiled once per distinct schema instead of once per route.
 *
 * Without this, each route × error status compiles its own fast-json-stringify
 * serializer (each with its own Ajv instance). With ~340 routes sharing the same
 * handful of error schemas that was ~1,100 identical serializers and ~40 MB of heap.
 *
 * Output is byte-identical: the same compiler, with the same options, produces the
 * serializer — it is only reused. 2xx schemas are left untouched (each is unique
 * per route, so caching them would only add hashing cost).
 *
 * @param {(externalSchemas: object, serializerOpts: object) => Function} baseFactory
 *   Fastify serializer factory, e.g. `SerializerSelector()` from
 *   `@fastify/fast-json-stringify-compiler`.
 * @returns {(externalSchemas: object, serializerOpts: object) => Function}
 */
export function createErrorSerializerCacheFactory(baseFactory) {
  return function buildSerializerFactory(externalSchemas, serializerOpts) {
    const compile = baseFactory(externalSchemas, serializerOpts);
    // One cache per factory call: Fastify calls the factory per encapsulation context
    // with that context's external schemas, so entries never cross contexts.
    const cache = new Map();

    return function compileSerializer(routeSchemaInfo) {
      if (!ERROR_STATUS_PATTERN.test(String(routeSchemaInfo.httpStatus))) {
        return compile(routeSchemaInfo);
      }

      const key = JSON.stringify(routeSchemaInfo.schema);
      let serializer = cache.get(key);
      if (!serializer) {
        serializer = compile(routeSchemaInfo);
        cache.set(key, serializer);
      }
      return serializer;
    };
  };
}
