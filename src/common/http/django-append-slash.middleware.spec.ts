import type { Request, Response } from 'express';
import { onBeforeHeaders } from './before-headers';
import { DjangoAppendSlashMiddleware } from './django-append-slash.middleware';
import { DJANGO_URL_CONF } from './django-url-conf';

/**
 * `CommonMiddleware`'s `APPEND_SLASH` half, unit-pinned — findings **N1** (it is above the
 * CORS middleware) and **N2** (`Location` is `escape_uri_path(PATH_INFO)`, not the request
 * target). Every `Location` below was read off the live v1 (Django 2.2.27, gunicorn, DEBUG
 * off); the request/response placement is proved end-to-end in `test/http-edge.e2e-spec.ts`.
 */
describe('DjangoAppendSlashMiddleware', () => {
  const middleware = new DjangoAppendSlashMiddleware(DJANGO_URL_CONF);

  function fakeResponse(): Response & { headers: Record<string, string>; ended: boolean } {
    const headers: Record<string, string> = { 'X-Powered-By': 'Express' };
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

  function run(
    originalUrl: string,
    method = 'POST',
  ): { response: ReturnType<typeof fakeResponse>; nextCalled: boolean } {
    const request = { method, originalUrl, headers: {} } as unknown as Request;
    const response = fakeResponse();
    let nextCalled = false;
    middleware.use(request, response, () => {
      nextCalled = true;
    });
    return { response, nextCalled };
  }

  describe('should_redirect_with_slash', () => {
    it.each(['/password_reset', '/password_reset/done', '/reset/done', '/reset/MQ/abc-def'])(
      '301s %s — the bare form of a mandatory-slash route',
      (path) => {
        const { response, nextCalled } = run(path);
        expect(response.statusCode).toBe(301);
        expect(response.headers.Location).toBe(`${path}/`);
        expect(nextCalled).toBe(false);
      },
    );

    it('redirects a POST as well — v1 runs with DEBUG off, where Django does not raise', () => {
      expect(run('/password_reset', 'POST').response.statusCode).toBe(301);
      expect(run('/password_reset', 'PATCH').response.statusCode).toBe(301);
      expect(run('/password_reset', 'OPTIONS').response.statusCode).toBe(301);
    });

    it.each([
      ['/password_reset/', 'the path already resolves'],
      ['/api/notification/subscribe', 'the path already resolves'],
      ['/api/loan/1/', 'neither form resolves — the slashed form is not a route'],
      ['/nope/nope', 'neither form resolves'],
      ['/api/notification/subscribe//', 'the doubly-slashed form is not a route'],
    ])('passes %s through (%s)', (path) => {
      const { response, nextCalled } = run(path);
      expect(nextCalled).toBe(true);
      expect(response.ended).toBe(false);
      expect(response.statusCode).toBe(200);
    });
  });

  describe('N2 — Location is built from the decoded path, then re-encoded', () => {
    it.each([
      ['/password%5Freset', '/password_reset/'],
      ['/password%5freset', '/password_reset/'],
      ['/pass%77ord_reset', '/password_reset/'],
      ['/password_reset%2Fdone', '/password_reset/done/'],
      ['/reset/M%51/abc-def', '/reset/MQ/abc-def/'],
    ])('redirects %s to %s, as v1 does', (target, location) => {
      expect(run(target).response.headers.Location).toBe(location);
    });

    it('passes the query string through iri_to_uri, leaving existing escapes alone', () => {
      expect(run('/password_reset?a=%C3%B1&b=1').response.headers.Location).toBe(
        '/password_reset/?a=%C3%B1&b=1',
      );
      expect(run('/password_reset?x=%zz').response.headers.Location).toBe('/password_reset/?x=%zz');
    });

    it('emits no `?` for an empty query string, as Django does not', () => {
      expect(run('/password_reset?').response.headers.Location).toBe('/password_reset/');
    });
  });

  describe('N4 — the fragment never reaches PATH_INFO or the Location (C18)', () => {
    // gunicorn parses the target with `urlsplit` and puts only `path`/`query` into the
    // environ, so Django cannot see a fragment. Every `Location` below was read off v1 over a
    // raw socket, because supertest/superagent strips the `#` before writing the request line
    // and therefore cannot express these shapes at all.
    it('301s a bare fragment — v1: 301, v2 before the fix: 404', () => {
      const { response } = run('/password_reset#frag');
      expect(response.statusCode).toBe(301);
      expect(response.headers.Location).toBe('/password_reset/');
    });

    it('keeps the query but drops the fragment — v2 before the fix leaked `#frag`', () => {
      const { response } = run('/password_reset?a=1#frag');
      expect(response.statusCode).toBe(301);
      expect(response.headers.Location).toBe('/password_reset/?a=1');
    });

    it('leaves %23 encoded, which stays a 404 — the control on the fix', () => {
      // `%23` decodes to a literal `#` inside PATH_INFO, and `/password_reset#frag` is not a
      // route, so neither form resolves and CommonMiddleware passes it through to the 404.
      const { response, nextCalled } = run('/password_reset%23frag');
      expect(nextCalled).toBe(true);
      expect(response.ended).toBe(false);
    });

    it.each([
      ['/password_reset#frag?a=1', '/password_reset/'],
      ['/password_reset?a=1#f1#f2', '/password_reset/?a=1'],
      ['/password_reset#', '/password_reset/'],
      ['/password_reset?a=1#', '/password_reset/?a=1'],
    ])('splits %s on the first # — Location %s', (target, location) => {
      expect(run(target).response.headers.Location).toBe(location);
    });
  });

  describe('the response is the one Django builds above the CORS middleware', () => {
    it('is a 301 with an empty text/html body and no Express-isms', () => {
      const { response } = run('/password_reset');
      expect(response.statusCode).toBe(301);
      expect(response.headers['Content-Type']).toBe('text/html; charset=utf-8');
      expect(response.headers['Content-Length']).toBe('0');
      expect(response.headers['X-Powered-By']).toBeUndefined();
      expect(response.ended).toBe(true);
    });

    it('carries no Vary / X-Frame-Options / Access-Control-*, whatever is registered', () => {
      // Belt and braces: with the fixed order nothing has registered a hook yet, but a
      // future reorder must not start decorating this response.
      const response = fakeResponse();
      onBeforeHeaders(response, (finished) => {
        finished.setHeader('Vary', 'Origin');
        finished.setHeader('X-Frame-Options', 'SAMEORIGIN');
      });
      middleware.use(
        { method: 'POST', originalUrl: '/password_reset', headers: {} } as Request,
        response,
        () => {
          throw new Error('next() must not run');
        },
      );
      expect(response.statusCode).toBe(301);
      expect(response.headers.Vary).toBeUndefined();
      expect(response.headers['X-Frame-Options']).toBeUndefined();
    });
  });
});
