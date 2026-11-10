import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSignedFileHook } from '../../api/hooks/signed-file-hook.js';
import { SIGNED_FILE_ANNOTATION } from '../../src/helpers/signed-file-walker.js';

const KEY = 'exercise-videos/t/a.mp4';

// Builds a response schema whose key field is annotated.
function annotatedSchema() {
  return {
    type: 'object',
    properties: {
      videoFileKey: { type: ['string', 'null'], [SIGNED_FILE_ANNOTATION]: 'videoFileUrl' },
      videoFileUrl: { type: ['string', 'null'] },
    },
  };
}

// Builds a Fastify-like request carrying the given response schemas.
function buildRequest(response) {
  return { routeOptions: { schema: { response } } };
}

describe('signed-file-hook', () => {
  let resolveUrl;
  let hook;

  beforeEach(() => {
    resolveUrl = vi.fn(async (key) => (key ? `signed:${key}` : null));
    hook = createSignedFileHook(resolveUrl);
  });

  it('should fill the url sibling using the schema of the exact status code', async () => {
    const payload = { videoFileKey: KEY };

    const result = await hook(buildRequest({ 200: annotatedSchema() }), { statusCode: 200 }, payload);

    expect(result).toBe(payload);
    expect(payload.videoFileUrl).toBe(`signed:${KEY}`);
  });

  it('should fall back to the 2xx schema', async () => {
    const payload = { videoFileKey: KEY };

    await hook(buildRequest({ '2xx': annotatedSchema() }), { statusCode: 201 }, payload);

    expect(payload.videoFileUrl).toBe(`signed:${KEY}`);
  });

  it('should fall back to the default schema', async () => {
    const payload = { videoFileKey: KEY };

    await hook(buildRequest({ default: annotatedSchema() }), { statusCode: 200 }, payload);

    expect(payload.videoFileUrl).toBe(`signed:${KEY}`);
  });

  it('should set null url when the key is null', async () => {
    const payload = { videoFileKey: null };

    await hook(buildRequest({ 200: annotatedSchema() }), { statusCode: 200 }, payload);

    expect(payload.videoFileUrl).toBeNull();
  });

  it('should leave payload untouched when the schema has no annotation', async () => {
    const payload = { videoFileKey: KEY };
    const schema = { type: 'object', properties: { videoFileKey: { type: 'string' } } };

    await hook(buildRequest({ 200: schema }), { statusCode: 200 }, payload);

    expect(payload).toEqual({ videoFileKey: KEY });
  });

  it('should return the payload unchanged when the route has no response schema', async () => {
    const payload = { videoFileKey: KEY };

    const result = await hook({ routeOptions: {} }, { statusCode: 200 }, payload);

    expect(result).toBe(payload);
    expect(resolveUrl).not.toHaveBeenCalled();
  });

  it('should return the payload unchanged when no schema matches the status code', async () => {
    const payload = { videoFileKey: KEY };

    await hook(buildRequest({ 404: annotatedSchema() }), { statusCode: 200 }, payload);

    expect(resolveUrl).not.toHaveBeenCalled();
  });

  it('should skip error responses', async () => {
    const payload = { videoFileKey: KEY };

    await hook(buildRequest({ '4xx': annotatedSchema() }), { statusCode: 400 }, payload);

    expect(resolveUrl).not.toHaveBeenCalled();
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'text'],
  ])('should pass through a %s payload', async (_label, payload) => {
    const result = await hook(buildRequest({ 200: annotatedSchema() }), { statusCode: 200 }, payload);

    expect(result).toBe(payload);
  });
});
