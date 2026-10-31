import { describe, it, expect, vi } from 'vitest';
import { parseAppMinVersions, resolveAppMinVersion } from '../../src/services/app-version-service.js';
import { MobilePlatform } from '../../src/constants/mobile-app.js';

const APP_ID = 'br.com.teufit.coach';
const MIN_VERSION = '1.2.0';
const STORE_URL = 'https://store.example/app';

const CONFIG = {
  [APP_ID]: {
    [MobilePlatform.IOS]: { minVersion: MIN_VERSION, storeUrl: STORE_URL },
    [MobilePlatform.ANDROID]: { minVersion: 42, storeUrl: '' },
  },
};

describe('app-version-service', () => {
  describe('parseAppMinVersions', () => {
    it('should return an empty object when the value is undefined', () => {
      const logger = { error: vi.fn() };

      expect(parseAppMinVersions(undefined, logger)).toEqual({});
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('should return an empty object when the value is an empty string', () => {
      expect(parseAppMinVersions('', { error: vi.fn() })).toEqual({});
    });

    it('should return the parsed object when the JSON is valid', () => {
      expect(parseAppMinVersions(JSON.stringify(CONFIG), { error: vi.fn() })).toEqual(CONFIG);
    });

    it('should log an error and return an empty object when the JSON is malformed', () => {
      const logger = { error: vi.fn() };

      expect(parseAppMinVersions('{not json', logger)).toEqual({});
      expect(logger.error).toHaveBeenCalledOnce();
    });

    it.each(['[]', '"text"', '42', 'null'])('should log and return an empty object when the JSON is %s', (raw) => {
      const logger = { error: vi.fn() };

      expect(parseAppMinVersions(raw, logger)).toEqual({});
      expect(logger.error).toHaveBeenCalledOnce();
    });
  });

  describe('resolveAppMinVersion', () => {
    it('should return the configured version and store url for a known app and platform', () => {
      expect(resolveAppMinVersion(CONFIG, { appId: APP_ID, platform: MobilePlatform.IOS })).toEqual({
        appId: APP_ID,
        platform: MobilePlatform.IOS,
        minVersion: MIN_VERSION,
        storeUrl: STORE_URL,
      });
    });

    it('should return nulls for an unknown app', () => {
      expect(resolveAppMinVersion(CONFIG, { appId: 'unknown.app', platform: MobilePlatform.IOS })).toMatchObject({
        minVersion: null,
        storeUrl: null,
      });
    });

    it('should return nulls for an unsupported platform', () => {
      expect(resolveAppMinVersion(CONFIG, { appId: APP_ID, platform: 'windows' })).toMatchObject({
        minVersion: null,
        storeUrl: null,
      });
    });

    it.each(['__proto__', 'constructor', 'toString', 'hasOwnProperty'])(
      'should return nulls when the appId is the prototype key %s',
      (appId) => {
        expect(resolveAppMinVersion(CONFIG, { appId, platform: MobilePlatform.IOS })).toMatchObject({
          minVersion: null,
          storeUrl: null,
        });
      },
    );

    it('should return nulls when the stored fields are not non-empty strings', () => {
      expect(resolveAppMinVersion(CONFIG, { appId: APP_ID, platform: MobilePlatform.ANDROID })).toMatchObject({
        minVersion: null,
        storeUrl: null,
      });
    });
  });
});
