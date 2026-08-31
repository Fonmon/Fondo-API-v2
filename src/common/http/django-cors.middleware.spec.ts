import type { Request, Response } from 'express';
import {
  CORS_ALLOW_HEADERS,
  CORS_ALLOW_METHODS,
  CORS_PREFLIGHT_MAX_AGE,
  DjangoCorsMiddleware,
  patchVaryHeaders,
} from './django-cors.middleware';

/**
 * Unit-level pinning of `corsheaders.CorsMiddleware` 2.4.0. The end-to-end proof that a bare
 * `OPTIONS` reaches the guards is in `test/http-edge.e2e-spec.ts` (finding **F1**); this file
 * pins the decision itself, which is the part `app.enableCors()` got wrong.
 */
describe('DjangoCorsMiddleware', () => {
  const middleware = new DjangoCorsMiddleware();

  function fakeResponse(): Response & { headers: Record<string, string>; ended: boolean } {
    const headers: Record<string, string> = {};
    const response = {
      statusCode: 200,
      headers,
      ended: false,
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
      writeHead() {
        return response;
      },
      end() {
        response.ended = true;
        response.writeHead(response.statusCode);
        return response;
      },
    } as unknown as Response & { headers: Record<string, string>; ended: boolean };
    return response;
  }

  function fakeRequest(method: string, headers: Record<string, string> = {}): Request {
    return { method, headers } as unknown as Request;
  }

  function run(request: Request): {
    response: ReturnType<typeof fakeResponse>;
    nextCalled: boolean;
  } {
    const response = fakeResponse();
    let nextCalled = false;
    middleware.use(request, response, () => {
      nextCalled = true;
    });
    // The non-preflight path defers its headers to `writeHead`.
    if (nextCalled) {
      response.end();
    }
    return { response, nextCalled };
  }

  describe('the short circuit is a genuine preflight, not any OPTIONS (F1)', () => {
    it('short-circuits an OPTIONS carrying Access-Control-Request-Method', () => {
      const { response, nextCalled } = run(
        fakeRequest('OPTIONS', {
          origin: 'http://x.test',
          'access-control-request-method': 'POST',
        }),
      );

      expect(nextCalled).toBe(false);
      expect(response.statusCode).toBe(200);
      expect(response.headers).toMatchObject({
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': '0',
        Vary: 'Origin',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': CORS_ALLOW_HEADERS,
        'Access-Control-Allow-Methods': CORS_ALLOW_METHODS,
        'Access-Control-Max-Age': CORS_PREFLIGHT_MAX_AGE,
      });
    });

    it('short-circuits without an Origin too — 2.4.0 checks only the request-method header', () => {
      const { response, nextCalled } = run(
        fakeRequest('OPTIONS', { 'access-control-request-method': 'POST' }),
      );

      expect(nextCalled).toBe(false);
      expect(response.statusCode).toBe(200);
      // `process_response` returns early when there is no Origin, so only Vary is patched.
      expect(response.headers.Vary).toBe('Origin');
      expect(response.headers['Access-Control-Allow-Origin']).toBeUndefined();
      expect(response.headers['Access-Control-Max-Age']).toBeUndefined();
    });

    it('short-circuits on an empty-valued header — Django tests for presence in META', () => {
      const { nextCalled } = run(fakeRequest('OPTIONS', { 'access-control-request-method': '' }));
      expect(nextCalled).toBe(false);
    });

    it('⚠️ lets a bare OPTIONS through to the guards — the whole of F1', () => {
      const { response, nextCalled } = run(fakeRequest('OPTIONS', { origin: 'http://x.test' }));

      expect(nextCalled).toBe(true);
      expect(response.ended).toBe(true);
      // v1 still decorates the eventual 401/403 with the OPTIONS trio.
      expect(response.headers['Access-Control-Allow-Methods']).toBe(CORS_ALLOW_METHODS);
      expect(response.headers['Access-Control-Max-Age']).toBe(CORS_PREFLIGHT_MAX_AGE);
    });

    it('lets a bare OPTIONS with no Origin through as well', () => {
      const { response, nextCalled } = run(fakeRequest('OPTIONS'));

      expect(nextCalled).toBe(true);
      expect(response.headers.Vary).toBe('Origin');
      expect(response.headers['Access-Control-Allow-Origin']).toBeUndefined();
    });
  });

  describe('process_response on an ordinary request', () => {
    it('patches Vary: Origin even with no Origin header — the patch precedes the early exit', () => {
      const { response } = run(fakeRequest('POST'));

      expect(response.headers.Vary).toBe('Origin');
      expect(response.headers['Access-Control-Allow-Origin']).toBeUndefined();
    });

    it('answers `*`, not the origin (CORS_ORIGIN_ALLOW_ALL, no credentials)', () => {
      const { response } = run(fakeRequest('POST', { origin: 'http://x.test' }));

      expect(response.headers['Access-Control-Allow-Origin']).toBe('*');
      expect(response.headers['Access-Control-Allow-Credentials']).toBeUndefined();
      expect(response.headers['Access-Control-Expose-Headers']).toBeUndefined();
    });

    it('adds the OPTIONS trio only for OPTIONS', () => {
      const { response } = run(fakeRequest('GET', { origin: 'http://x.test' }));

      expect(response.headers['Access-Control-Allow-Headers']).toBeUndefined();
      expect(response.headers['Access-Control-Allow-Methods']).toBeUndefined();
      expect(response.headers['Access-Control-Max-Age']).toBeUndefined();
    });
  });
});

describe('patchVaryHeaders — django.utils.cache.patch_vary_headers', () => {
  function responseWith(vary?: string): Response & { headers: Record<string, string> } {
    const headers: Record<string, string> = {};
    if (vary !== undefined) {
      headers.Vary = vary;
    }
    return {
      headers,
      setHeader(name: string, value: string) {
        headers[name] = String(value);
      },
      getHeader(name: string) {
        return headers[name];
      },
    } as unknown as Response & { headers: Record<string, string> };
  }

  it('sets the field when there is no Vary', () => {
    const response = responseWith();
    patchVaryHeaders(response, ['Origin']);
    expect(response.headers.Vary).toBe('Origin');
  });

  it('appends to what DRF already set — v1 answers `Accept, Origin`', () => {
    const response = responseWith('Accept');
    patchVaryHeaders(response, ['Origin']);
    expect(response.headers.Vary).toBe('Accept, Origin');
  });

  it('does not duplicate, case-insensitively', () => {
    const response = responseWith('accept, ORIGIN');
    patchVaryHeaders(response, ['Origin', 'Accept']);
    expect(response.headers.Vary).toBe('accept, ORIGIN');
  });

  it('collapses to * when either side is *', () => {
    const response = responseWith('*');
    patchVaryHeaders(response, ['Origin']);
    expect(response.headers.Vary).toBe('*');
  });
});
