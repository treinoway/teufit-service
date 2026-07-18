import { describe, it, expect } from 'vitest';
import {
  assertAsaasWebhookSecretConfigured,
  isValidAsaasWebhookToken,
} from '../../src/helpers/asaas-webhook-helpers.js';

describe('assertAsaasWebhookSecretConfigured', () => {
  describe('when apiKey is absent (Asaas not integrated)', () => {
    it('does not throw for production with no secret', () => {
      expect(() =>
        assertAsaasWebhookSecretConfigured({
          env: 'production',
          apiKey: undefined,
          webhookSecret: undefined,
        }),
      ).not.toThrow();
    });

    it('does not throw for staging with no secret', () => {
      expect(() =>
        assertAsaasWebhookSecretConfigured({
          env: 'staging',
          apiKey: undefined,
          webhookSecret: undefined,
        }),
      ).not.toThrow();
    });

    it('does not throw for development with no secret', () => {
      expect(() =>
        assertAsaasWebhookSecretConfigured({
          env: 'development',
          apiKey: undefined,
          webhookSecret: undefined,
        }),
      ).not.toThrow();
    });

    it('does not throw for production with an empty-string apiKey', () => {
      expect(() =>
        assertAsaasWebhookSecretConfigured({
          env: 'production',
          apiKey: '',
          webhookSecret: undefined,
        }),
      ).not.toThrow();
    });
  });

  describe('when apiKey is present and env requires the secret', () => {
    it('throws for production with an undefined secret', () => {
      expect(() =>
        assertAsaasWebhookSecretConfigured({
          env: 'production',
          apiKey: 'test-asaas-api-key',
          webhookSecret: undefined,
        }),
      ).toThrow(/ASAAS_WEBHOOK_SECRET/);
    });

    it('throws for production with an empty-string secret', () => {
      expect(() =>
        assertAsaasWebhookSecretConfigured({
          env: 'production',
          apiKey: 'test-asaas-api-key',
          webhookSecret: '',
        }),
      ).toThrow(/ASAAS_WEBHOOK_SECRET/);
    });

    it('throws for staging with an undefined secret', () => {
      expect(() =>
        assertAsaasWebhookSecretConfigured({
          env: 'staging',
          apiKey: 'test-asaas-api-key',
          webhookSecret: undefined,
        }),
      ).toThrow(/ASAAS_WEBHOOK_SECRET/);
    });

    it('does not throw for production when a secret is configured', () => {
      expect(() =>
        assertAsaasWebhookSecretConfigured({
          env: 'production',
          apiKey: 'test-asaas-api-key',
          webhookSecret: 'some-secret',
        }),
      ).not.toThrow();
    });

    it('does not throw for staging when a secret is configured', () => {
      expect(() =>
        assertAsaasWebhookSecretConfigured({
          env: 'staging',
          apiKey: 'test-asaas-api-key',
          webhookSecret: 'some-secret',
        }),
      ).not.toThrow();
    });
  });

  describe('when apiKey is present but env does not require the secret', () => {
    it('does not throw for development with an undefined secret', () => {
      expect(() =>
        assertAsaasWebhookSecretConfigured({
          env: 'development',
          apiKey: 'test-asaas-api-key',
          webhookSecret: undefined,
        }),
      ).not.toThrow();
    });

    it('does not throw for test with an undefined secret', () => {
      expect(() =>
        assertAsaasWebhookSecretConfigured({
          env: 'test',
          apiKey: 'test-asaas-api-key',
          webhookSecret: undefined,
        }),
      ).not.toThrow();
    });
  });
});

describe('isValidAsaasWebhookToken', () => {
  it('returns true when the token matches the expected secret', () => {
    expect(isValidAsaasWebhookToken('abc', 'abc')).toBe(true);
  });

  it('returns false when the token does not match the expected secret', () => {
    expect(isValidAsaasWebhookToken('abc', 'abd')).toBe(false);
  });

  it('returns false without throwing when lengths differ', () => {
    expect(() => isValidAsaasWebhookToken('ab', 'abc')).not.toThrow();
    expect(isValidAsaasWebhookToken('ab', 'abc')).toBe(false);
  });

  it('returns false when the incoming token is undefined (missing header)', () => {
    expect(isValidAsaasWebhookToken(undefined, 'abc')).toBe(false);
  });

  it('returns false when the incoming token is an empty string', () => {
    expect(isValidAsaasWebhookToken('', 'abc')).toBe(false);
  });

  it('returns false when the incoming token is not a string (e.g. array from duplicate headers)', () => {
    expect(isValidAsaasWebhookToken(['abc', 'abc'], 'abc')).toBe(false);
  });

  describe('when expectedSecret is invalid', () => {
    it('returns false without throwing when expectedSecret is undefined', () => {
      expect(() => isValidAsaasWebhookToken('abc', undefined)).not.toThrow();
      expect(isValidAsaasWebhookToken('abc', undefined)).toBe(false);
    });

    it('returns false without throwing when expectedSecret is null', () => {
      expect(() => isValidAsaasWebhookToken('abc', null)).not.toThrow();
      expect(isValidAsaasWebhookToken('abc', null)).toBe(false);
    });

    it('returns false without throwing when expectedSecret is an empty string', () => {
      expect(() => isValidAsaasWebhookToken('abc', '')).not.toThrow();
      expect(isValidAsaasWebhookToken('abc', '')).toBe(false);
    });

    it('returns false without throwing when expectedSecret is not a string (e.g. a number)', () => {
      expect(() => isValidAsaasWebhookToken('abc', 123)).not.toThrow();
      expect(isValidAsaasWebhookToken('abc', 123)).toBe(false);
    });
  });
});
