import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerDevice, removeDevice } from '../../src/services/device-service.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const FCM_TOKEN = 'fcm-token-abc123';
const PLATFORM_IOS = 'ios';
const COACH_APP_ID = 'br.com.teufit.coach';

let prismaMock;

// Builds a Prisma stand-in exposing only the device delegate the service may use.
function buildPrismaMock() {
  return {
    device: {
      upsert: vi.fn(),
      deleteMany: vi.fn(),
    },
  };
}

describe('device-service', () => {
  beforeEach(() => {
    prismaMock = buildPrismaMock();
  });

  describe('registerDevice', () => {
    it('should upsert the token keyed by token so repeated calls never duplicate it', async () => {
      prismaMock.device.upsert.mockResolvedValue({ token: FCM_TOKEN });

      await registerDevice(
        USER_ID,
        { token: FCM_TOKEN, platform: PLATFORM_IOS, appId: COACH_APP_ID },
        prismaMock,
      );

      expect(prismaMock.device.upsert).toHaveBeenCalledTimes(1);
      expect(prismaMock.device.upsert.mock.calls[0][0].where).toEqual({ token: FCM_TOKEN });
    });

    it('should create the device for the authenticated user with platform and appId', async () => {
      prismaMock.device.upsert.mockResolvedValue({ token: FCM_TOKEN });

      await registerDevice(
        USER_ID,
        { token: FCM_TOKEN, platform: PLATFORM_IOS, appId: COACH_APP_ID },
        prismaMock,
      );

      expect(prismaMock.device.upsert.mock.calls[0][0].create).toMatchObject({
        userId: USER_ID,
        token: FCM_TOKEN,
        platform: PLATFORM_IOS,
        appId: COACH_APP_ID,
      });
    });

    it('should move an existing token to the new owner on update', async () => {
      prismaMock.device.upsert.mockResolvedValue({ token: FCM_TOKEN });

      await registerDevice(
        USER_ID,
        { token: FCM_TOKEN, platform: PLATFORM_IOS, appId: COACH_APP_ID },
        prismaMock,
      );

      expect(prismaMock.device.upsert.mock.calls[0][0].update).toMatchObject({
        userId: USER_ID,
        platform: PLATFORM_IOS,
        appId: COACH_APP_ID,
      });
    });

    it('should return the registered device token, platform and appId', async () => {
      prismaMock.device.upsert.mockResolvedValue({
        id: 'ignored',
        userId: USER_ID,
        token: FCM_TOKEN,
        platform: PLATFORM_IOS,
        appId: COACH_APP_ID,
      });

      const result = await registerDevice(
        USER_ID,
        { token: FCM_TOKEN, platform: PLATFORM_IOS, appId: COACH_APP_ID },
        prismaMock,
      );

      expect(result).toMatchObject({ token: FCM_TOKEN, platform: PLATFORM_IOS, appId: COACH_APP_ID });
    });
  });

  describe('removeDevice', () => {
    it('should delete only the token owned by the given user', async () => {
      prismaMock.device.deleteMany.mockResolvedValue({ count: 1 });

      await removeDevice(USER_ID, FCM_TOKEN, prismaMock);

      expect(prismaMock.device.deleteMany).toHaveBeenCalledWith({
        where: { token: FCM_TOKEN, userId: USER_ID },
      });
    });

    it('should resolve without error when the token does not exist for the user', async () => {
      prismaMock.device.deleteMany.mockResolvedValue({ count: 0 });

      await expect(removeDevice(USER_ID, FCM_TOKEN, prismaMock)).resolves.not.toThrow();
    });
  });
});
