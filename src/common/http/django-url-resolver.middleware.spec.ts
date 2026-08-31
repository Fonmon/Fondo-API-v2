import type { Request, Response } from 'express';
import { DJANGO_URL_CONF } from './django-url-conf';
import { DjangoUrlResolverMiddleware } from './django-url-resolver.middleware';

/**
 * The resolver half of the URL layer: the 404, DRF's per-view headers, and — finding **N3**,
 * condition **C17** — handing Nest's router the path Django dispatches on rather than the raw
 * request target.
 */
describe('DjangoUrlResolverMiddleware', () => {
  const middleware = new DjangoUrlResolverMiddleware(DJANGO_URL_CONF);

  function fakeResponse(): Response & { headers: Record<string, string>; body?: unknown } {
    const headers: Record<string, string> = {};
    const response = {
      statusCode: 200,
      headers,
      body: undefined as unknown,
      setHeader(name: string, value: string) {
        headers[name] = String(value);
        return response;
      },
      getHeader(name: string) {
        return headers[name];
      },
      removeHeader(name: string) {
        delete headers[name];
      },
      status(code: number) {
        response.statusCode = code;
        return response;
      },
      json(payload: unknown) {
        response.body = payload;
        return response;
      },
      writeHead() {
        return response;
      },
      end() {
        return response;
      },
    } as unknown as Response & { headers: Record<string, string>; body?: unknown };
    return response;
  }

  function run(originalUrl: string): {
    request: Request;
    response: ReturnType<typeof fakeResponse>;
    nextCalled: boolean;
  } {
    const request = { method: 'POST', originalUrl, url: originalUrl, headers: {} } as Request;
    const response = fakeResponse();
    let nextCalled = false;
    middleware.use(request, response, () => {
      nextCalled = true;
    });
    return { request, response, nextCalled };
  }

  describe('resolution', () => {
    it('passes a path v1 serves through to the guards', () => {
      const { nextCalled, response } = run('/api/notification/subscribe');
      expect(nextCalled).toBe(true);
      expect(response.headers.Allow).toBe('POST, OPTIONS');
      expect(response.headers.Vary).toBe('Accept');
    });

    it('404s a path v1 does not serve, before any guard (D13 body shape)', () => {
      const { nextCalled, response } = run('/API/notification/subscribe');
      expect(nextCalled).toBe(false);
      expect(response.statusCode).toBe(404);
      expect(response.body).toEqual({ message: 'Not Found' });
    });

    it('no longer 301s — the APPEND_SLASH redirect moved above the CORS middleware (N1)', () => {
      const { nextCalled, response } = run('/password_reset');
      expect(response.statusCode).toBe(404);
      expect(nextCalled).toBe(false);
    });
  });

  describe('N3 — the router is handed PATH_INFO, not the request target', () => {
    it.each([
      ['/api%2Dtoken%2Dauth', '/api-token-auth'],
      ['/api/%6Eotification/subscribe', '/api/notification/subscribe'],
      ['/%61pi/notification/subscribe', '/api/notification/subscribe'],
      ['/api/notification/%73ubscribe', '/api/notification/subscribe'],
    ])('rewrites %s to %s', (target, expected) => {
      const { request, nextCalled } = run(target);
      expect(nextCalled).toBe(true);
      expect(request.url).toBe(expected);
      // The raw target survives for logging and for anything that re-reads it.
      expect(request.originalUrl).toBe(target);
    });

    it('keeps the query string exactly as it arrived', () => {
      const { request } = run('/api/%6Eotification/subscribe?a=%C3%B1&b=1');
      expect(request.url).toBe('/api/notification/subscribe?a=%C3%B1&b=1');
    });

    it('leaves an already-decoded target untouched', () => {
      const { request } = run('/api/notification/subscribe');
      expect(request.url).toBe('/api/notification/subscribe');
    });

    it('never rewrites a target that did not resolve', () => {
      const { request } = run('/api/notification/sub%2Fscribe');
      expect(request.url).toBe('/api/notification/sub%2Fscribe');
    });
  });

  describe("DRF's default_response_headers", () => {
    it('gives ObtainAuthToken Allow but no Vary: Accept', () => {
      const { response } = run('/api-token-auth');
      expect(response.headers.Allow).toBe('POST, OPTIONS');
      expect(response.headers.Vary).toBeUndefined();
    });

    it('gives the Django auth pages no DRF headers at all', () => {
      const { response } = run('/password_reset/');
      expect(response.headers.Allow).toBeUndefined();
      expect(response.headers.Vary).toBeUndefined();
    });
  });
});
