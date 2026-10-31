import { describe, it, expect, vi } from 'vitest';

const mockInitializeApp = vi.fn();
const mockCert = vi.fn();
const mockSend = vi.fn();
const mockGetMessaging = vi.fn();

vi.mock('firebase-admin/app', () => ({
  initializeApp: (...args) => mockInitializeApp(...args),
  cert: (...args) => mockCert(...args),
}));
vi.mock('firebase-admin/messaging', () => ({
  getMessaging: (...args) => mockGetMessaging(...args),
}));

import { createFcmClient } from '../../src/push/fcm-client.js';
import { MobileAppEnv, FCM_APP_NAME } from '../../src/constants/mobile-app.js';

const TOKEN = 'abcdefghijklmnop';

// Builds a logger stub recording every level.
function buildLogger() {
  return { warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

describe('fcm-client', () => {
  describe('createFcmClient', () => {
    it('should return a no-op client and warn when no credential is configured', async () => {
      const logger = buildLogger();

      const client = await createFcmClient({ env: {}, logger });

      await expect(client.sendToToken({ token: TOKEN })).resolves.toEqual({ messageId: null });
      expect(logger.warn).toHaveBeenCalledOnce();
      expect(mockInitializeApp).not.toHaveBeenCalled();
    });

    it('should return a no-op client and log an error when the credential is malformed JSON', async () => {
      const logger = buildLogger();

      const client = await createFcmClient({ env: { [MobileAppEnv.FCM_SERVICE_ACCOUNT]: '{bad' }, logger });

      await expect(client.sendToToken({ token: TOKEN })).resolves.toEqual({ messageId: null });
      expect(logger.error).toHaveBeenCalledOnce();
      expect(mockInitializeApp).not.toHaveBeenCalled();
    });

    it('should log only a token prefix when the no-op client skips a send', async () => {
      const logger = buildLogger();
      const client = await createFcmClient({ env: {}, logger });

      await client.sendToToken({ token: TOKEN });

      expect(logger.debug).toHaveBeenCalledWith({ tokenPrefix: TOKEN.slice(0, 8) }, expect.any(String));
    });

    it('should send through firebase messaging when the credential is valid', async () => {
      const logger = buildLogger();
      const account = { project_id: 'p' };
      mockCert.mockReturnValue('cred');
      mockInitializeApp.mockReturnValue('app');
      mockGetMessaging.mockReturnValue({ send: mockSend });
      mockSend.mockResolvedValue('msg-1');

      const client = await createFcmClient({
        env: { [MobileAppEnv.FCM_SERVICE_ACCOUNT]: JSON.stringify(account) },
        logger,
      });
      const result = await client.sendToToken({ token: TOKEN, notification: { title: 't' }, data: { a: '1' } });

      expect(result).toEqual({ messageId: 'msg-1' });
      expect(mockInitializeApp).toHaveBeenCalledWith({ credential: 'cred' }, FCM_APP_NAME);
      expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({ token: TOKEN, data: { a: '1' } }));
    });

    it('should fall back to a no-op client and log an error when firebase initialization fails', async () => {
      const logger = buildLogger();
      mockInitializeApp.mockImplementation(() => {
        throw new Error('boom');
      });

      const client = await createFcmClient({
        env: { [MobileAppEnv.FCM_SERVICE_ACCOUNT]: JSON.stringify({ project_id: 'p' }) },
        logger,
      });

      await expect(client.sendToToken({ token: TOKEN })).resolves.toEqual({ messageId: null });
      expect(logger.error).toHaveBeenCalledOnce();
    });
  });
});
