import { describe, it, expect } from 'vitest';
import {
  redactSensitiveUrl,
  redactSentryEvent,
  serializeRequestForLog,
  withRedactedRequestSerializer,
} from '../../src/helpers/log-redaction.js';

const REDACTED = '[redacted]';
const SECRET_TOKEN = 'fcm-secret-token:APA91b';

describe('redactSensitiveUrl', () => {
  it('should mask the token in the device removal path', () => {
    expect(redactSensitiveUrl(`/me/devices/${SECRET_TOKEN}`)).toBe(`/me/devices/${REDACTED}`);
  });

  it('should mask a URL-encoded token', () => {
    const encoded = encodeURIComponent(SECRET_TOKEN);

    expect(redactSensitiveUrl(`/me/devices/${encoded}`)).toBe(`/me/devices/${REDACTED}`);
  });

  it('should drop a token followed by a query string without leaking it', () => {
    const redacted = redactSensitiveUrl(`/me/devices/${SECRET_TOKEN}?foo=bar`);

    expect(redacted).not.toContain(SECRET_TOKEN);
    expect(redacted.startsWith(`/me/devices/${REDACTED}`)).toBe(true);
  });

  it('should leave the device collection URL untouched', () => {
    expect(redactSensitiveUrl('/me/devices')).toBe('/me/devices');
  });

  it('should leave unrelated URLs untouched', () => {
    const url = '/my/workout-sessions/abc-123?x=1';

    expect(redactSensitiveUrl(url)).toBe(url);
  });

  it('should return non-string values as they are', () => {
    expect(redactSensitiveUrl(undefined)).toBeUndefined();
  });
});

describe('serializeRequestForLog', () => {
  it('should keep the default request fields and redact the url', () => {
    const request = {
      method: 'DELETE',
      url: `/me/devices/${SECRET_TOKEN}`,
      headers: { 'accept-version': '1.0.0' },
      host: 'localhost',
      ip: '127.0.0.1',
      socket: { remotePort: 4321 },
    };

    expect(serializeRequestForLog(request)).toEqual({
      method: 'DELETE',
      url: `/me/devices/${REDACTED}`,
      version: '1.0.0',
      host: 'localhost',
      remoteAddress: '127.0.0.1',
      remotePort: 4321,
    });
  });
});

describe('withRedactedRequestSerializer', () => {
  it('should keep false as false', () => {
    expect(withRedactedRequestSerializer(false)).toBe(false);
  });

  it('should pass a logger instance through unchanged', () => {
    const loggerInstance = { info: () => {}, error: () => {} };

    expect(withRedactedRequestSerializer(loggerInstance)).toBe(loggerInstance);
  });

  it('should turn true into options carrying the req serializer', () => {
    const options = withRedactedRequestSerializer(true);

    expect(options.serializers.req).toBe(serializeRequestForLog);
  });

  it('should merge into object options keeping the stream, level and other serializers', () => {
    const stream = { write: () => {} };
    const resSerializer = () => ({});

    const options = withRedactedRequestSerializer({ level: 'info', stream, serializers: { res: resSerializer } });

    expect(options).toMatchObject({ level: 'info', stream });
    expect(options.serializers).toEqual({ res: resSerializer, req: serializeRequestForLog });
  });
});

describe('redactSensitiveUrl unanchored', () => {
  it('should mask the token inside a full URL', () => {
    expect(redactSensitiveUrl('https://x.test/me/devices/TOKEN?a=1')).toBe(`https://x.test/me/devices/${REDACTED}?a=1`);
  });

  it('should mask the token in a "METHOD path" transaction name', () => {
    expect(redactSensitiveUrl('DELETE /me/devices/TOKEN')).toBe(`DELETE /me/devices/${REDACTED}`);
  });

  it('should mask every occurrence in the same string', () => {
    const redacted = redactSensitiveUrl('GET /me/devices/AAA then /me/devices/BBB');

    expect(redacted).toBe(`GET /me/devices/${REDACTED} then /me/devices/${REDACTED}`);
  });
});

describe('redactSentryEvent', () => {
  const TOKEN = 'fcm-secret-token:APA91b';
  const PATH = `/me/devices/${TOKEN}`;
  const REDACTED_PATH = `/me/devices/${REDACTED}`;

  function buildEvent() {
    return {
      transaction: `DELETE ${PATH}`,
      request: { url: `https://api.test${PATH}`, method: 'DELETE' },
      tags: { route: '/me/devices' },
      spans: [
        {
          description: `DELETE https://api.test${PATH}`,
          data: { 'url.full': `https://api.test${PATH}`, 'http.url': `https://api.test${PATH}`, 'http.status_code': 204 },
        },
      ],
      breadcrumbs: [{ category: 'http', data: { url: `https://api.test${PATH}` } }],
    };
  }

  it('should mask the token in the request url and the transaction name', () => {
    const event = redactSentryEvent(buildEvent());

    expect(event.request.url).toBe(`https://api.test${REDACTED_PATH}`);
    expect(event.transaction).toBe(`DELETE ${REDACTED_PATH}`);
  });

  it('should mask the token in span descriptions and span data urls', () => {
    const [span] = redactSentryEvent(buildEvent()).spans;

    expect(span.description).toBe(`DELETE https://api.test${REDACTED_PATH}`);
    expect(span.data['url.full']).toBe(`https://api.test${REDACTED_PATH}`);
    expect(span.data['http.url']).toBe(`https://api.test${REDACTED_PATH}`);
    expect(span.data['http.status_code']).toBe(204);
  });

  it('should mask the token in breadcrumb data urls', () => {
    const [crumb] = redactSensitiveBreadcrumbs();

    expect(crumb.data.url).toBe(`https://api.test${REDACTED_PATH}`);
  });

  function redactSensitiveBreadcrumbs() {
    return redactSentryEvent(buildEvent()).breadcrumbs;
  }

  it('should leave values without a token untouched', () => {
    const event = redactSentryEvent(buildEvent());

    expect(event.tags.route).toBe('/me/devices');
    expect(event.request.method).toBe('DELETE');
  });

  it('should not mutate the input object', () => {
    const input = buildEvent();

    redactSentryEvent(input);

    expect(input).toEqual(buildEvent());
  });

  it('should not leak the token anywhere in the serialized event', () => {
    expect(JSON.stringify(redactSentryEvent(buildEvent()))).not.toContain(TOKEN);
  });

  it.each([[null], [undefined], [42], [true]])('should return %s as it is', (value) => {
    expect(redactSentryEvent(value)).toBe(value);
  });

  it('should redact a plain string', () => {
    expect(redactSentryEvent(`DELETE ${PATH}`)).toBe(`DELETE ${REDACTED_PATH}`);
  });

  it('should stop at the depth cap without throwing on very deep structures', () => {
    let deep = { url: PATH };
    for (let i = 0; i < 50; i += 1) deep = { child: deep };

    expect(() => redactSentryEvent(deep)).not.toThrow();
  });

  it('should keep null members inside objects and arrays', () => {
    expect(redactSentryEvent({ a: null, list: [null, PATH] })).toEqual({ a: null, list: [null, REDACTED_PATH] });
  });
});
