import { Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { AppConfigService } from '../../config/app-config.service';
import { DjangoStack, onBeforeHeaders } from './before-headers';
import { DjangoAllowedHostsMiddleware } from './django-allowed-hosts.middleware';

/**
 * Condition **C19** at the middleware level: the 400 short-circuit, and the fact that it
 * carries nothing the layers below slot 3 would have added.
 *
 * The end-to-end placement — above the CORS preflight, above the `APPEND_SLASH` 301 and
 * above the resolver — is pinned in `test/http-edge.e2e-spec.ts`.
 */
describe('DjangoAllowedHostsMiddleware (C19)', () => {
  function config(overrides: Partial<AppConfigService>): AppConfigService {
    return {
      allowedHosts: ['localhost', '127.0.0.1'],
      debug: false,
      ...overrides,
    } as AppConfigService;
  }

  function fakeResponse(): Response & { headers: Record<string, string>; body: string } {
    const headers: Record<string, string> = { 'X-Powered-By': 'Express' };
    const response = {
      statusCode: 200,
      headers,
      body: '',
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
      end(chunk?: string) {
        response.body = chunk ?? '';
        response.writeHead(response.statusCode);
        return response;
      },
    } as unknown as Response & { headers: Record<string, string>; body: string };
    return response;
  }

  function run(
    host: string | undefined,
    appConfig: AppConfigService = config({}),
  ): { response: ReturnType<typeof fakeResponse>; nextCalled: boolean } {
    const middleware = new DjangoAllowedHostsMiddleware(appConfig);
    const headers = host === undefined ? {} : { host };
    const request = { method: 'GET', originalUrl: '/api/loan', headers } as unknown as Request;
    const response = fakeResponse();
    let nextCalled = false;
    middleware.use(request, response, () => {
      nextCalled = true;
    });
    return { response, nextCalled };
  }

  let logged: string[];

  beforeEach(() => {
    // The middleware logs Django's `django.security.DisallowedHost` line on every refusal.
    logged = [];
    jest.spyOn(Logger.prototype, 'error').mockImplementation((message: unknown) => {
      logged.push(String(message));
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each(['localhost', 'localhost:8443', '127.0.0.1', 'LOCALHOST'])(
    'calls next() for an allowed host (%s)',
    (host) => {
      const { response, nextCalled } = run(host);

      expect(nextCalled).toBe(true);
      expect(response.statusCode).toBe(200);
    },
  );

  it('400s a forged host before anything else runs — v1: 400 on every route', () => {
    const { response, nextCalled } = run('evil.test');

    expect(nextCalled).toBe(false);
    expect(response.statusCode).toBe(400);
    expect(response.body).toBe('{"message":"Bad Request"}');
    expect(response.headers['Content-Type']).toBe('application/json');
    expect(response.headers['Content-Length']).toBe('25');
  });

  it('400s a request with no Host header at all (P2-D9)', () => {
    const { response, nextCalled } = run(undefined);

    expect(nextCalled).toBe(false);
    expect(response.statusCode).toBe(400);
  });

  it('suppresses the response phases below slot 3 — no Vary, no X-Frame-Options, no CORS', () => {
    const middleware = new DjangoAllowedHostsMiddleware(config({}));
    const response = fakeResponse();
    // Stand in for the hooks `DjangoResponseHeadersMiddleware` and `DjangoCorsMiddleware`
    // would have registered if this middleware had called next().
    onBeforeHeaders(response, DjangoStack.X_FRAME_OPTIONS, (finished: Response) => {
      finished.setHeader('X-Frame-Options', 'SAMEORIGIN');
    });
    onBeforeHeaders(response, DjangoStack.CORS, (finished: Response) => {
      finished.setHeader('Vary', 'Origin');
    });

    middleware.use(
      {
        method: 'GET',
        originalUrl: '/api/loan',
        headers: { host: 'evil.test' },
      } as unknown as Request,
      response,
      () => undefined,
    );

    expect(response.statusCode).toBe(400);
    expect(response.headers['X-Frame-Options']).toBeUndefined();
    expect(response.headers['Vary']).toBeUndefined();
  });

  it('strips X-Powered-By itself, because the hook that normally does is below it', () => {
    const { response } = run('evil.test');

    expect(response.headers['X-Powered-By']).toBeUndefined();
  });

  it('logs Django’s DisallowedHost message and never puts it in the body', () => {
    const { response } = run('evil.test');

    expect(logged.join('\n')).toContain('Invalid HTTP_HOST header');
    expect(response.body).not.toContain('evil.test');
  });

  it('applies the DEBUG fallback when the allowlist is empty (development/test)', () => {
    const development = config({ allowedHosts: [], debug: true });

    expect(run('localhost', development).nextCalled).toBe(true);
    expect(run('[::1]', development).nextCalled).toBe(true);
    expect(run('evil.test', development).nextCalled).toBe(false);
  });

  it('refuses everything when the allowlist is empty and DEBUG is off', () => {
    const misconfigured = config({ allowedHosts: [], debug: false });

    expect(run('localhost', misconfigured).nextCalled).toBe(false);
    expect(run('127.0.0.1', misconfigured).nextCalled).toBe(false);
  });
});
