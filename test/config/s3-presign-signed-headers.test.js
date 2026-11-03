import { describe, it, expect, vi, afterEach } from 'vitest';

const OBJECT_KEY = 'exercise-videos/trainer-1/file.mp4';
const CONTENT_TYPE = 'video/mp4';
const CONTENT_LENGTH = 2048;

// Loads the handler singleton with dummy S3 credentials so real presigning runs.
async function loadRealHandler() {
  vi.stubEnv('DISABLE_S3_UPLOAD', 'false');
  vi.stubEnv('AWS_DEFAULT_REGION', 'us-east-1');
  vi.stubEnv('AWS_ACCESS_KEY_ID', 'AKIATESTKEY');
  vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'test-secret');
  vi.stubEnv('AWS_S3_BUCKET_NAME', 'test-bucket');
  vi.stubEnv('AWS_ENDPOINT_URL', 'https://s3.example.test');
  vi.resetModules();
  return (await import('../../src/config/s3-bucket-handler.js')).default;
}

// Returns the signed header names of a presigned URL.
function signedHeaders(url) {
  return new URL(url).searchParams.get('X-Amz-SignedHeaders').split(';');
}

describe('s3-bucket-handler real presigning', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('should sign host, content-type and content-length on a PUT URL with a content length', async () => {
    const handler = await loadRealHandler();

    const url = await handler.getSignedPutUrl({ key: OBJECT_KEY, contentType: CONTENT_TYPE, contentLength: CONTENT_LENGTH });

    expect(signedHeaders(url)).toEqual(expect.arrayContaining(['host', 'content-type', 'content-length']));
  });

  it('should sign content-type on a PUT URL without a content length', async () => {
    const handler = await loadRealHandler();

    const url = await handler.getSignedPutUrl({ key: OBJECT_KEY, contentType: CONTENT_TYPE });

    expect(signedHeaders(url)).toEqual(expect.arrayContaining(['host', 'content-type']));
  });
});
