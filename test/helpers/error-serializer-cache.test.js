import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import { SerializerSelector } from '@fastify/fast-json-stringify-compiler';
import { createErrorSerializerCacheFactory } from '../../src/helpers/error-serializer-cache.js';
import {
  errorResponseSchema,
  badRequestErrorResponseSchema,
} from '../../api/schemas/error-response.schema.js';

function spyFactory() {
  const compile = vi.fn(() => () => '{}');
  const baseFactory = vi.fn(() => compile);
  return { baseFactory, compile };
}

describe('createErrorSerializerCacheFactory', () => {
  it('compiles an error schema once and reuses it across routes', () => {
    const { baseFactory, compile } = spyFactory();
    const compileSerializer = createErrorSerializerCacheFactory(baseFactory)({}, {});

    const first = compileSerializer({ schema: errorResponseSchema, httpStatus: '401', url: '/a' });
    const second = compileSerializer({ schema: errorResponseSchema, httpStatus: '404', url: '/b' });

    expect(compile).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it('reuses structurally equal schemas even when they are different objects', () => {
    const { baseFactory, compile } = spyFactory();
    const compileSerializer = createErrorSerializerCacheFactory(baseFactory)({}, {});

    compileSerializer({ schema: { ...errorResponseSchema }, httpStatus: '500' });
    compileSerializer({ schema: { ...errorResponseSchema }, httpStatus: '500' });

    expect(compile).toHaveBeenCalledTimes(1);
  });

  it('compiles different error schemas separately', () => {
    const { baseFactory, compile } = spyFactory();
    const compileSerializer = createErrorSerializerCacheFactory(baseFactory)({}, {});

    compileSerializer({ schema: errorResponseSchema, httpStatus: '401' });
    compileSerializer({ schema: badRequestErrorResponseSchema, httpStatus: '400' });

    expect(compile).toHaveBeenCalledTimes(2);
  });

  it.each(['200', '201', '204', '2xx', 'default'])(
    'does not cache non-error status %s',
    (httpStatus) => {
      const { baseFactory, compile } = spyFactory();
      const compileSerializer = createErrorSerializerCacheFactory(baseFactory)({}, {});
      const schema = { type: 'object', properties: { id: { type: 'string' } } };

      compileSerializer({ schema, httpStatus });
      compileSerializer({ schema, httpStatus });

      expect(compile).toHaveBeenCalledTimes(2);
    },
  );

  it('caches the 4xx/5xx range keys', () => {
    const { baseFactory, compile } = spyFactory();
    const compileSerializer = createErrorSerializerCacheFactory(baseFactory)({}, {});

    compileSerializer({ schema: errorResponseSchema, httpStatus: '4xx' });
    compileSerializer({ schema: errorResponseSchema, httpStatus: '5xx' });

    expect(compile).toHaveBeenCalledTimes(1);
  });

  it('keeps a separate cache per factory call (encapsulation context)', () => {
    const { baseFactory, compile } = spyFactory();
    const factory = createErrorSerializerCacheFactory(baseFactory);

    factory({}, {})({ schema: errorResponseSchema, httpStatus: '401' });
    factory({ Shared: { $id: 'Shared' } }, {})({ schema: errorResponseSchema, httpStatus: '401' });

    expect(compile).toHaveBeenCalledTimes(2);
  });

  it('forwards external schemas and serializer options to the base factory', () => {
    const { baseFactory } = spyFactory();
    const externalSchemas = { Shared: { $id: 'Shared' } };
    const serializerOpts = { rounding: 'floor' };

    createErrorSerializerCacheFactory(baseFactory)(externalSchemas, serializerOpts);

    expect(baseFactory).toHaveBeenCalledWith(externalSchemas, serializerOpts);
  });
});

describe('createErrorSerializerCacheFactory wired into Fastify', () => {
  async function buildApp(schemaController) {
    const app = Fastify({ logger: false, ...(schemaController && { schemaController }) });
    const response = { 200: { type: 'object', properties: { ok: { type: 'boolean' } } } };
    response[401] = errorResponseSchema;
    response[400] = badRequestErrorResponseSchema;

    app.get('/ok', { schema: { response } }, async () => ({ ok: true, hidden: 'dropped' }));
    app.get('/unauthorized', { schema: { response } }, async (request, reply) =>
      reply.code(401).send({
        error: 'UNAUTHORIZED',
        messageCode: 'auth.unauthorized',
        message: 'Nope',
        details: {},
        extra: 'kept by additionalProperties',
      }),
    );
    app.get('/validation', { schema: { response } }, async (request, reply) =>
      reply.code(400).send({
        error: 'VALIDATION_ERROR',
        messageCode: 'validation.failed',
        message: 'Invalid',
        details: [{ field: 'name', validations: ['required'] }],
      }),
    );
    await app.ready();
    return app;
  }

  it('produces byte-identical bodies to the default serializer', async () => {
    const defaultApp = await buildApp();
    const cachedApp = await buildApp({
      compilersFactory: {
        buildSerializer: createErrorSerializerCacheFactory(SerializerSelector()),
      },
    });

    for (const url of ['/ok', '/unauthorized', '/validation']) {
      const expected = await defaultApp.inject({ method: 'GET', url });
      const actual = await cachedApp.inject({ method: 'GET', url });
      expect(actual.statusCode).toBe(expected.statusCode);
      expect(actual.body).toBe(expected.body);
    }

    await defaultApp.close();
    await cachedApp.close();
  });
});
