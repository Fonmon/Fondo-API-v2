import type { Request, Response } from 'express';
import { DJANGO_URL_CONF, type RequestWithDjangoRoute } from './django-url-conf';
import { DjangoUrlResolverMiddleware } from './django-url-resolver.middleware';
import { markDrfRendered } from './drf-finalize-response';

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
    request: Request & RequestWithDjangoRoute;
    response: ReturnType<typeof fakeResponse>;
    nextCalled: boolean;
  } {
    const request = {
      method: 'POST',
      originalUrl,
      url: originalUrl,
      headers: {},
    } as Request & RequestWithDjangoRoute;
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

  /**
   * Parity finding **F1**. The strip models `convert_exception_to_response` replacing the
   * response object, which only happens for an **uncaught** exception. A 500 a DRF view
   * *returned* went through `finalize_response` and keeps `Allow` and `Vary: Accept` —
   * `UserAppsView.post`'s `except Exception: return Response(status=500)` is the one v1 has,
   * and it is measurably `Vary: Accept, Origin` / `Allow: POST, OPTIONS` on the live stack.
   */
  describe('F1 — the 500 strip asks who built the response, not what the status is', () => {
    it('strips Allow and Vary: Accept from a 500 Django built', () => {
      const { response } = run('/api/user/power');
      response.statusCode = 500;
      response.writeHead(500);

      expect(response.headers.Allow).toBeUndefined();
      expect(response.headers.Vary).toBeUndefined();
    });

    it('keeps both on a 500 DRF rendered', () => {
      const { response } = run('/api/user/power');
      response.statusCode = 500;
      markDrfRendered(response);
      response.writeHead(500);

      expect(response.headers.Allow).toBe('POST, OPTIONS');
      expect(response.headers.Vary).toBe('Accept');
    });

    it('leaves a non-500 alone either way', () => {
      const { response } = run('/api/user/power');
      response.statusCode = 403;
      response.writeHead(403);

      expect(response.headers.Allow).toBe('POST, OPTIONS');
      expect(response.headers.Vary).toBe('Accept');
    });
  });

  describe('C20 — it publishes which v1 view answered, not just that one did', () => {
    it('attaches the matched pattern to the request', () => {
      const { request } = run('/api/notification/subscribe');

      expect(request.djangoRoute?.view).toBe('NotificationView');
    });

    it('resolves /api/user/power to UserAppsView — the pattern order, not the segment shape', () => {
      // Measured on live v1: `Allow: POST, OPTIONS` on that path, i.e. UserAppsView answered.
      expect(run('/api/user/power').request.djangoRoute?.view).toBe('UserAppsView');
      expect(run('/api/user/-power').request.djangoRoute?.view).toBe('UserAppsView');
    });

    it('resolves /api/user/5 and the -1 sentinel to UserDetailView', () => {
      expect(run('/api/user/5').request.djangoRoute?.view).toBe('UserDetailView');
      expect(run('/api/user/-1').request.djangoRoute?.view).toBe('UserDetailView');
    });

    it('leaves nothing attached when nothing resolved — the guard must not guess', () => {
      const { request, nextCalled } = run('/nope/nope');

      expect(nextCalled).toBe(false);
      expect(request.djangoRoute).toBeUndefined();
    });
  });
});
