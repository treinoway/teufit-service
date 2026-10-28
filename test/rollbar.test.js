import { describe, it, expect, vi, beforeEach } from 'vitest';

// Loads src/rollbar.js fresh with the given rollbar config and a stubbed Rollbar constructor.
async function loadRollbarModule(rollbarConfig) {
  const RollbarMock = vi.fn(function RollbarStub(options) {
    this.options = options;
  });
  vi.doMock('rollbar', () => ({ default: RollbarMock }));
  vi.doMock('../config/index.js', () => ({ default: { rollbar: rollbarConfig } }));
  const { rollbar } = await import('../src/rollbar.js');
  return { rollbar, RollbarMock };
}

describe('src/rollbar.js', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('exports null and never builds a client when the access token is absent', async () => {
    const { rollbar, RollbarMock } = await loadRollbarModule({
      accessToken: null,
      environment: 'beta',
      codeVersion: null,
    });

    expect(rollbar).toBeNull();
    expect(RollbarMock).not.toHaveBeenCalled();
  });

  it('builds a client that captures uncaught errors and still exits on uncaught exceptions', async () => {
    const { rollbar, RollbarMock } = await loadRollbarModule({
      accessToken: 'token-123',
      environment: 'production',
      codeVersion: 'abc123',
    });

    expect(rollbar).not.toBeNull();
    expect(RollbarMock).toHaveBeenCalledTimes(1);
    expect(RollbarMock.mock.calls[0][0]).toMatchObject({
      accessToken: 'token-123',
      environment: 'production',
      codeVersion: 'abc123',
      captureUncaught: true,
      captureUnhandledRejections: true,
      exitOnUncaughtException: true,
    });
  });

  it('omits codeVersion when no commit SHA is available', async () => {
    const { RollbarMock } = await loadRollbarModule({
      accessToken: 'token-123',
      environment: 'beta',
      codeVersion: null,
    });

    expect(RollbarMock.mock.calls[0][0].codeVersion).toBeUndefined();
  });
});
