import { Inject, Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { skipBeforeHeadersHooks } from './before-headers';
import {
  DJANGO_URL_CONF_TOKEN,
  decodePathInfo,
  resolveDjangoUrl,
  type DjangoUrlPattern,
} from './django-url-conf';
import { escapeLeadingSlashes, escapeUriPath, iriToUri } from './django-uri-encoding';
import { splitQuery } from './request-target';

/**
 * `django.middleware.common.CommonMiddleware`'s `APPEND_SLASH` half — parity finding **N1**,
 * condition **C15**.
 *
 * ## Why this is its own middleware, separate from the resolver
 *
 * v1's `MIDDLEWARE` (`api/settings/base.py:38-46`) is:
 *
 * ```
 * 1 SecurityMiddleware        5 AuthenticationMiddleware
 * 2 SessionMiddleware         6 MessageMiddleware
 * 3 CommonMiddleware          7 XFrameOptionsMiddleware
 * 4 CsrfViewMiddleware        8 corsheaders.CorsMiddleware
 * ```
 *
 * and Django's URL **resolution** happens in `BaseHandler._get_response`, i.e. *below* all
 * eight. So the 301 and the 404 that v2's first cut produced from one middleware live at two
 * different depths of v1's stack, on opposite sides of the CORS preflight short-circuit:
 *
 * | Request | v1 | Why |
 * |---|---|---|
 * | preflight `OPTIONS /password_reset` | **301** | `CommonMiddleware` (3) runs before CORS (8) |
 * | preflight `OPTIONS /nope/nope` | **200** | CORS (8) runs before the resolver, which is below it |
 *
 * Both verified live. A middleware that did the 301 *and* the 404 could only match one of
 * them, whichever side of `DjangoCorsMiddleware` it was registered on — v2 was 200/200 before
 * this split (finding N1), and a naive swap of the two entries would have made it 301/404.
 * {@link DjangoUrlResolverMiddleware} keeps the 404 and the DRF view headers; this class
 * keeps the redirect and is registered *above* CORS, where `CommonMiddleware` sits.
 *
 * ## The response phase
 *
 * `CommonMiddleware` returns its 301 from `process_request`, so the response never passes
 * through the middlewares *below* it: v1's 301 carries no `Vary`, no `X-Frame-Options` and no
 * `Access-Control-*`, even with an `Origin` header. Registered first, this middleware reaches
 * that branch before anything has registered a `onBeforeHeaders` hook; the
 * {@link skipBeforeHeadersHooks} call keeps it true if the order is ever changed back.
 *
 * ⚠️ In `DEBUG` mode Django raises `RuntimeError` for a POST/PUT/PATCH here instead of
 * redirecting. v1 deploys with `DEBUG = False` (`api/settings/production.py:16`), so the 301
 * is the production behaviour for **every** method, verified with `POST`.
 */
@Injectable()
export class DjangoAppendSlashMiddleware implements NestMiddleware {
  constructor(
    @Inject(DJANGO_URL_CONF_TOKEN) private readonly urlConf: readonly DjangoUrlPattern[],
  ) {}

  use(request: Request, response: Response, next: NextFunction): void {
    const [rawPath, rawQuery] = splitQuery(request.originalUrl);
    const pathInfo = decodePathInfo(rawPath);

    if (!this.shouldRedirectWithSlash(pathInfo)) {
      next();
      return;
    }

    this.redirectWithSlash(response, pathInfo, rawQuery);
  }

  /**
   * `should_redirect_with_slash`: `APPEND_SLASH` is on (Django's default; v1 never overrides
   * it), the path does not already end in `/`, it does not resolve, and the slashed form does.
   */
  private shouldRedirectWithSlash(pathInfo: string): boolean {
    return (
      !pathInfo.endsWith('/') &&
      resolveDjangoUrl(pathInfo, this.urlConf) === null &&
      resolveDjangoUrl(`${pathInfo}/`, this.urlConf) !== null
    );
  }

  /**
   * `get_full_path_with_slash` → `escape_leading_slashes` → `HttpResponsePermanentRedirect`.
   *
   * `Location` is **`escape_uri_path(PATH_INFO) + '/'`**, i.e. built from the *decoded* path
   * and re-encoded — not echoed from the request target (finding N2). `QUERY_STRING` goes
   * through `iri_to_uri`, which leaves an already-encoded query alone.
   */
  private redirectWithSlash(response: Response, pathInfo: string, rawQuery: string): void {
    skipBeforeHeadersHooks(response);

    const query = rawQuery === '' ? '' : `?${iriToUri(rawQuery)}`;
    const location = escapeLeadingSlashes(`${escapeUriPath(pathInfo)}/${query}`);

    // Express sets this in its own `init` middleware, above everything Nest registers, and
    // `DjangoResponseHeadersMiddleware` — which normally strips it — is below this one.
    response.removeHeader('X-Powered-By');
    response.statusCode = 301;
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.setHeader('Location', location);
    response.setHeader('Content-Length', '0');
    response.end();
  }
}
