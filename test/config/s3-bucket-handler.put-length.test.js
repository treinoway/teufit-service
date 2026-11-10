import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const putCommandInstances = [];
const CONTENT_LENGTH = 52428800;

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn(),
  PutObjectCommand: vi.fn(function PutObjectCommand(input) {
    this.input = input;
    putCommandInstances.push(this);
  }),
  DeleteObjectCommand: vi.fn(),
  GetObjectCommand: vi.fn(),
}));

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn().mockResolvedValue('https://signed.example/put'),
}));

// Re-imports the handler singleton after env changes.
async function loadHandler() {
  vi.resetModules();
  const presigner = await import('@aws-sdk/s3-request-presigner');
  const handler = (await import('../../src/config/s3-bucket-handler.js')).default;
  return { handler, getSignedUrl: presigner.getSignedUrl };
}

describe('s3-bucket-handler getSignedPutUrl with contentLength', () => {
  beforeEach(() => {
    putCommandInstances.length = 0;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('signs ContentLength into the PutObjectCommand when contentLength is given', async () => {
    vi.stubEnv('DISABLE_S3_UPLOAD', 'false');
    vi.stubEnv('AWS_DEFAULT_REGION', 'us-east-1');
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'key');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'secret');
    vi.stubEnv('AWS_S3_BUCKET_NAME', 'test-bucket');
    const { handler } = await loadHandler();

    await handler.getSignedPutUrl({
      key: 'exercise-videos/t1/a.mp4',
      contentType: 'video/mp4',
      contentLength: CONTENT_LENGTH,
      expiresIn: 900,
    });

    expect(putCommandInstances[0].input).toEqual({
      Bucket: 'test-bucket',
      Key: 'exercise-videos/t1/a.mp4',
      ContentType: 'video/mp4',
      ContentLength: CONTENT_LENGTH,
    });
  });

  it('omits ContentLength when contentLength is not given (tutorial uploads keep working)', async () => {
    vi.stubEnv('DISABLE_S3_UPLOAD', 'false');
    vi.stubEnv('AWS_DEFAULT_REGION', 'us-east-1');
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'key');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'secret');
    vi.stubEnv('AWS_S3_BUCKET_NAME', 'test-bucket');
    const { handler } = await loadHandler();

    await handler.getSignedPutUrl({ key: 'tutorials/a.mp4', contentType: 'video/mp4' });

    expect(putCommandInstances[0].input).not.toHaveProperty('ContentLength');
  });

  it('returns the disabled stub URL with contentLength when S3 uploads are disabled', async () => {
    vi.stubEnv('DISABLE_S3_UPLOAD', 'true');
    const { handler, getSignedUrl } = await loadHandler();

    const url = await handler.getSignedPutUrl({
      key: 'exercise-videos/t1/a.mp4',
      contentType: 'video/mp4',
      contentLength: CONTENT_LENGTH,
    });

    expect(url).toBe('https://example.com/disabled-s3-upload');
    expect(getSignedUrl).not.toHaveBeenCalled();
  });
});
