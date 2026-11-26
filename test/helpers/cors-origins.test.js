import { describe, expect, it } from 'vitest';
import { buildAllowedOrigins } from '../../src/helpers/cors-origins.js';

const APP_ORIGIN = 'https://app.teufit.com.br';
const ROOT_ORIGIN = 'https://teufit.com.br';
const REDIRECT_ORIGIN = 'https://redirect.teufit.com.br';
const BACKEND_ORIGIN = 'https://api.teufit.com.br';

describe('buildAllowedOrigins', () => {
  it('should return an empty list for an empty env', () => {
    expect(buildAllowedOrigins({})).toEqual([]);
  });

  it('should include FRONTEND_URL, FRONTEND_REDIRECT_URL and BACKEND_URL in that order', () => {
    const origins = buildAllowedOrigins({
      FRONTEND_URL: APP_ORIGIN,
      FRONTEND_REDIRECT_URL: REDIRECT_ORIGIN,
      BACKEND_URL: BACKEND_ORIGIN,
    });

    expect(origins).toEqual([APP_ORIGIN, REDIRECT_ORIGIN, BACKEND_ORIGIN]);
  });

  it('should drop undefined and empty single-valued vars', () => {
    const origins = buildAllowedOrigins({
      FRONTEND_URL: APP_ORIGIN,
      FRONTEND_REDIRECT_URL: '',
      BACKEND_URL: undefined,
    });

    expect(origins).toEqual([APP_ORIGIN]);
  });

  it('should remove a trailing slash from each origin', () => {
    const origins = buildAllowedOrigins({
      FRONTEND_URL: `${APP_ORIGIN}/`,
      BACKEND_URL: `${BACKEND_ORIGIN}/`,
    });

    expect(origins).toEqual([APP_ORIGIN, BACKEND_ORIGIN]);
  });

  it('should trim whitespace around single-valued vars', () => {
    expect(buildAllowedOrigins({ FRONTEND_URL: `  ${APP_ORIGIN}/  ` })).toEqual([APP_ORIGIN]);
  });

  describe('CORS_EXTRA_ORIGINS', () => {
    it('should append each comma-separated extra origin after the single-valued vars', () => {
      const origins = buildAllowedOrigins({
        FRONTEND_URL: APP_ORIGIN,
        BACKEND_URL: BACKEND_ORIGIN,
        CORS_EXTRA_ORIGINS: `${ROOT_ORIGIN},${REDIRECT_ORIGIN}`,
      });

      expect(origins).toEqual([APP_ORIGIN, BACKEND_ORIGIN, ROOT_ORIGIN, REDIRECT_ORIGIN]);
    });

    it('should trim entries, drop empty ones, strip trailing slashes and remove duplicates', () => {
      const origins = buildAllowedOrigins({
        FRONTEND_URL: `${APP_ORIGIN}/`,
        CORS_EXTRA_ORIGINS: ` ${ROOT_ORIGIN} , ,${APP_ORIGIN}`,
      });

      expect(origins).toEqual([APP_ORIGIN, ROOT_ORIGIN]);
    });

    it('should work alone, without FRONTEND_URL', () => {
      expect(buildAllowedOrigins({ CORS_EXTRA_ORIGINS: `${ROOT_ORIGIN}/` })).toEqual([ROOT_ORIGIN]);
    });

    it.each([[''], [' , ,'], [undefined]])('should add nothing for %j', (extra) => {
      expect(buildAllowedOrigins({ FRONTEND_URL: APP_ORIGIN, CORS_EXTRA_ORIGINS: extra })).toEqual([APP_ORIGIN]);
    });

    it('should dedupe an origin repeated within the extras', () => {
      expect(buildAllowedOrigins({ CORS_EXTRA_ORIGINS: `${ROOT_ORIGIN},${ROOT_ORIGIN}/` })).toEqual([ROOT_ORIGIN]);
    });
  });

  it('should dedupe FRONTEND_REDIRECT_URL when it equals FRONTEND_URL', () => {
    expect(buildAllowedOrigins({ FRONTEND_URL: APP_ORIGIN, FRONTEND_REDIRECT_URL: `${APP_ORIGIN}/` })).toEqual([
      APP_ORIGIN,
    ]);
  });

  it('should not mutate the env object it receives', () => {
    const env = Object.freeze({ FRONTEND_URL: `${APP_ORIGIN}/`, CORS_EXTRA_ORIGINS: ROOT_ORIGIN });

    expect(() => buildAllowedOrigins(env)).not.toThrow();
  });
});
