import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const putCommandInstances = [];

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

describe('s3-bucket-handler getSignedPutUrl', () => {
  beforeEach(() => {
    putCommandInstances.length = 0;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('presigns a PutObjectCommand with bucket, key and content type', async () => {
    vi.stubEnv('DISABLE_S3_UPLOAD', 'false');
    vi.stubEnv('AWS_DEFAULT_REGION', 'us-east-1');
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'key');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'secret');
    vi.stubEnv('AWS_S3_BUCKET_NAME', 'test-bucket');
    const { handler, getSignedUrl } = await loadHandler();

    const url = await handler.getSignedPutUrl({ key: 'tutorials/a.mp4', contentType: 'video/mp4', expiresIn: 600 });

    expect(url).toBe('https://signed.example/put');
    expect(putCommandInstances[0].input).toEqual({
      Bucket: 'test-bucket',
      Key: 'tutorials/a.mp4',
      ContentType: 'video/mp4',
    });
    expect(getSignedUrl).toHaveBeenCalledWith(handler.s3Client, putCommandInstances[0], {
      expiresIn: 600,
      signableHeaders: new Set(['content-type', 'content-length']),
    });
  });

  it('creates the client with checksums only when required so presigned PUTs accept browser bodies', async () => {
    vi.stubEnv('DISABLE_S3_UPLOAD', 'false');
    vi.stubEnv('AWS_DEFAULT_REGION', 'us-east-1');
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'key');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'secret');
    vi.stubEnv('AWS_S3_BUCKET_NAME', 'test-bucket');
    const { S3Client } = await import('@aws-sdk/client-s3');
    S3Client.mockClear();
    await loadHandler();
    const { S3Client: ReloadedS3Client } = await import('@aws-sdk/client-s3');

    expect(ReloadedS3Client).toHaveBeenCalledWith(
      expect.objectContaining({ requestChecksumCalculation: 'WHEN_REQUIRED' }),
    );
  });

  it('returns the stub URL when S3 uploads are disabled', async () => {
    vi.stubEnv('DISABLE_S3_UPLOAD', 'true');
    const { handler, getSignedUrl } = await loadHandler();

    const url = await handler.getSignedPutUrl({ key: 'tutorials/a.mp4', contentType: 'video/mp4' });

    expect(url).toBe('https://example.com/disabled-s3-upload');
    expect(getSignedUrl).not.toHaveBeenCalled();
  });
});
