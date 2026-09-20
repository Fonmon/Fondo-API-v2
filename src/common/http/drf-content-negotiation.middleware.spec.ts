import type { NextFunction, Request, Response } from 'express';
import { DrfContentNegotiationMiddleware } from './drf-content-negotiation.middleware';
import { DEFAULT_RENDERERS, JSON_ONLY_RENDERERS } from './drf-content-negotiation';
import type { DjangoUrlPattern, RequestWithDjangoRoute } from './django-url-conf';

/**
 * Parity finding **F6**, at the unit level. The *ordering* half of the finding — that the
 * 406 displaces a 401, a 403, a 405 and a write — is asserted end to end in
 * `test/content-negotiation.e2e-spec.ts`; what this file pins is the middleware's contract:
 * which route it acts on, what it writes, and that it hands the request on otherwise.
 */
describe('DrfContentNegotiationMiddleware', () => {
  const middleware = new DrfContentNegotiationMiddleware();

  const route = (renderers = DEFAULT_RENDERERS): DjangoUrlPattern => ({
    regex: /^api\/user\/?$/,
    view: 'UserView',
    drf: { allow: 'GET, POST, PATCH, HEAD, OPTIONS', renderers },
  });

  interface Probe {
    readonly request: Request;
    readonly response: Response;
    readonly next: NextFunction;
    readonly status: jest.Mock;
    readonly json: jest.Mock;
  }

  function probe(options: {
    accept?: string;
    url?: string;
    djangoRoute?: DjangoUrlPattern | null;
  }): Probe {
    const json = jest.fn();
    const status = jest.fn().mockReturnValue({ json });
    const request = {
      headers: options.accept === undefined ? {} : { accept: options.accept },
      originalUrl: options.url ?? '/api/user',
    } as unknown as Request & RequestWithDjangoRoute;
    if (options.djangoRoute !== null) {
      request.djangoRoute = options.djangoRoute ?? route();
    }
    return {
      request,
      response: { status } as unknown as Response,
      next: jest.fn(),
      status,
      json,
    };
  }

  it('calls next() when a renderer matches', () => {
    const it = probe({ accept: 'application/json' });
    middleware.use(it.request, it.response, it.next);
    expect(it.next).toHaveBeenCalledTimes(1);
    expect(it.status).not.toHaveBeenCalled();
  });

  it('writes DRF`s 406 body when nothing matches, and does not call next()', () => {
    const it = probe({ accept: 'application/xml' });
    middleware.use(it.request, it.response, it.next);
    expect(it.next).not.toHaveBeenCalled();
    expect(it.status).toHaveBeenCalledWith(406);
    expect(it.json).toHaveBeenCalledWith({
      detail: 'Could not satisfy the request Accept header.',
    });
  });

  it('writes DRF`s 404 body for a `?format=` no renderer declares', () => {
    const it = probe({ accept: '*/*', url: '/api/user?format=xml&page=1' });
    middleware.use(it.request, it.response, it.next);
    expect(it.next).not.toHaveBeenCalled();
    expect(it.status).toHaveBeenCalledWith(404);
    expect(it.json).toHaveBeenCalledWith({ detail: 'Not found.' });
  });

  it('reads the renderers of the matched view, not a global list', () => {
    // `text/html` is a browsable page on `UserView` and a 406 on `ObtainAuthToken`.
    const browsable = probe({ accept: 'text/html' });
    middleware.use(browsable.request, browsable.response, browsable.next);
    expect(browsable.next).toHaveBeenCalledTimes(1);

    const jsonOnly = probe({ accept: 'text/html', djangoRoute: route(JSON_ONLY_RENDERERS) });
    middleware.use(jsonOnly.request, jsonOnly.response, jsonOnly.next);
    expect(jsonOnly.status).toHaveBeenCalledWith(406);
  });

  it('skips a route with no DRF layer — the four Django password-reset pages', () => {
    const it = probe({
      accept: 'application/xml',
      djangoRoute: { regex: /^password_reset\/$/, view: 'PasswordResetView', drf: null },
    });
    middleware.use(it.request, it.response, it.next);
    expect(it.next).toHaveBeenCalledTimes(1);
    expect(it.status).not.toHaveBeenCalled();
  });

  it('skips a request the URL resolver never saw', () => {
    // Only reachable from a test that assembles a partial module; in `AppModule` the
    // resolver runs immediately before this and 404s anything it cannot match.
    const it = probe({ accept: 'application/xml', djangoRoute: null });
    middleware.use(it.request, it.response, it.next);
    expect(it.next).toHaveBeenCalledTimes(1);
  });

  it('ignores the fragment and the path when reading `?format=`', () => {
    const it = probe({ accept: '*/*', url: '/api/user?page=1&format=json' });
    middleware.use(it.request, it.response, it.next);
    expect(it.next).toHaveBeenCalledTimes(1);
  });
});
