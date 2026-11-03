import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  applySignedFileUrls,
  compileSignedFilePaths,
  SIGNED_FILE_ANNOTATION,
} from '../../src/helpers/signed-file-walker.js';

// Fake resolver that prefixes non-empty keys with 'signed:'.
const resolveUrl = async (key) => (key ? `signed:${key}` : null);

// Builds a schema node with a key field annotated to fill the given url sibling.
function keySchema(urlField = 'videoFileUrl') {
  return { type: ['string', 'null'], [SIGNED_FILE_ANNOTATION]: urlField };
}

// Builds an object schema holding an annotated key and its url sibling.
function exerciseSchema() {
  return {
    type: 'object',
    properties: {
      videoFileKey: keySchema(),
      videoFileUrl: { type: ['string', 'null'] },
    },
  };
}

describe('signed-file-walker', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('compileSignedFilePaths', () => {
    it('should collect a root-level annotated field with an empty path', () => {
      expect(compileSignedFilePaths(exerciseSchema())).toEqual([
        { path: [], keyField: 'videoFileKey', urlField: 'videoFileUrl' },
      ]);
    });

    it('should use * segments for arrays and field names for nested objects', () => {
      const schema = {
        type: 'object',
        properties: { items: { type: 'array', items: { type: 'object', properties: { exercise: exerciseSchema() } } } },
      };

      expect(compileSignedFilePaths(schema)).toEqual([
        { path: ['items', '*', 'exercise'], keyField: 'videoFileKey', urlField: 'videoFileUrl' },
      ]);
    });

    it('should return an empty list for a schema without annotation', () => {
      const schema = { type: 'object', properties: { name: { type: 'string' } } };

      expect(compileSignedFilePaths(schema)).toEqual([]);
    });

    it('should cache the compiled descriptors on the schema', () => {
      const schema = exerciseSchema();

      expect(compileSignedFilePaths(schema)).toBe(compileSignedFilePaths(schema));
    });

    it('should not recompile after the first call', () => {
      const schema = exerciseSchema();
      const first = compileSignedFilePaths(schema);
      schema.properties.other = keySchema('otherUrl');

      expect(compileSignedFilePaths(schema)).toBe(first);
    });

    it('should throw outside production when the url sibling is not declared', () => {
      vi.stubEnv('NODE_ENV', 'development');
      const schema = { type: 'object', properties: { videoFileKey: keySchema() } };

      expect(() => compileSignedFilePaths(schema)).toThrow(/missing the 'videoFileUrl' sibling/);
    });

    it('should not throw in production when the url sibling is not declared', () => {
      vi.stubEnv('NODE_ENV', 'production');
      const schema = { type: 'object', properties: { videoFileKey: keySchema() } };

      expect(compileSignedFilePaths(schema)).toHaveLength(1);
    });
  });

  describe('applySignedFileUrls', () => {
    it('should set the url sibling from the key on a root object', async () => {
      const payload = { videoFileKey: 'exercise-videos/t/a.mp4', videoFileUrl: null };

      await applySignedFileUrls(payload, exerciseSchema(), resolveUrl);

      expect(payload.videoFileUrl).toBe('signed:exercise-videos/t/a.mp4');
    });

    it('should set null when the key is null', async () => {
      const payload = { videoFileKey: null };

      await applySignedFileUrls(payload, exerciseSchema(), resolveUrl);

      expect(payload.videoFileUrl).toBeNull();
    });

    it('should leave a node untouched when it lacks the key field', async () => {
      const payload = { name: 'x' };

      await applySignedFileUrls(payload, exerciseSchema(), resolveUrl);

      expect(payload).toEqual({ name: 'x' });
    });

    it('should leave the payload untouched when the schema has no annotation', async () => {
      const payload = { videoFileKey: 'exercise-videos/t/a.mp4' };
      const schema = { type: 'object', properties: { videoFileKey: { type: 'string' } } };

      await applySignedFileUrls(payload, schema, resolveUrl);

      expect(payload).toEqual({ videoFileKey: 'exercise-videos/t/a.mp4' });
    });

    it('should resolve every item of a top-level array', async () => {
      const payload = [{ videoFileKey: 'exercise-videos/t/a.mp4' }, { videoFileKey: null }];
      const schema = { type: 'array', items: exerciseSchema() };

      await applySignedFileUrls(payload, schema, resolveUrl);

      expect(payload.map((item) => item.videoFileUrl)).toEqual(['signed:exercise-videos/t/a.mp4', null]);
    });

    it('should resolve nested objects inside arrays of objects', async () => {
      const payload = {
        trainings: [
          { exercises: [{ videoFileKey: 'exercise-videos/t/a.mp4' }, { videoFileKey: 'exercise-videos/t/b.mp4' }] },
          { exercises: [{ videoFileKey: null }] },
        ],
      };
      const schema = {
        type: 'object',
        properties: {
          trainings: {
            type: 'array',
            items: { type: 'object', properties: { exercises: { type: 'array', items: exerciseSchema() } } },
          },
        },
      };

      await applySignedFileUrls(payload, schema, resolveUrl);

      expect(payload.trainings.flatMap((t) => t.exercises.map((e) => e.videoFileUrl))).toEqual([
        'signed:exercise-videos/t/a.mp4',
        'signed:exercise-videos/t/b.mp4',
        null,
      ]);
    });

    it('should skip null or missing intermediate nodes without throwing', async () => {
      const payload = { exercise: null, list: undefined };
      const schema = {
        type: 'object',
        properties: { exercise: exerciseSchema(), list: { type: 'array', items: exerciseSchema() } },
      };

      await expect(applySignedFileUrls(payload, schema, resolveUrl)).resolves.toBeUndefined();
    });

    it('should skip a non-array where the schema expects an array', async () => {
      const payload = { list: { videoFileKey: 'exercise-videos/t/a.mp4' } };
      const schema = { type: 'object', properties: { list: { type: 'array', items: exerciseSchema() } } };

      await applySignedFileUrls(payload, schema, resolveUrl);

      expect(payload.list).not.toHaveProperty('videoFileUrl');
    });

    it('should honor a custom url sibling name', async () => {
      const payload = { fileKey: 'exercise-videos/t/a.mp4' };
      const schema = {
        type: 'object',
        properties: { fileKey: keySchema('fileUrl'), fileUrl: { type: ['string', 'null'] } },
      };

      await applySignedFileUrls(payload, schema, resolveUrl);

      expect(payload.fileUrl).toBe('signed:exercise-videos/t/a.mp4');
    });

    it('should call the resolver once per key found', async () => {
      const resolver = vi.fn(resolveUrl);
      const payload = [{ videoFileKey: 'exercise-videos/t/a.mp4' }, { videoFileKey: 'exercise-videos/t/b.mp4' }];

      await applySignedFileUrls(payload, { type: 'array', items: exerciseSchema() }, resolver);

      expect(resolver).toHaveBeenCalledTimes(2);
    });
  });
});
