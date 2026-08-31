import { Inject, Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { onBeforeHeaders, skipBeforeHeadersHooks } from './before-headers';
import { patchVaryHeaders } from './django-cors.middleware';
import {
  DJANGO_URL_CONF_TOKEN,
  decodePathInfo,
  resolveDjangoUrl,
  type DjangoUrlPattern,
} from './django-url-conf';
import { escapeLeadingSlashes, escapeUriPath, iriToUri } from './django-uri-encoding';

/**
 * Resolves the request against {@link DJANGO_URL_CONF} **before the guards**, exactly where
 * Django resolves it — review condition **C9**, parity findings **F2** and **P2-D5**.
 *
 * Three responsibilities, all of them Django's:
 *
 * 1. **`URLResolver.resolve`.** No pattern matches → 404, with no guard, no controller and no
 *    body parsing. This is what makes `POST /API/notification/subscribe` a 404 instead of a
 *    200-with-a-row (F2), `POST /api/notification/sub1` a 404 *before* authentication instead
 *    of a 401 (P2-D5), and `DELETE /api/user/5/` an inert 404 rather than a live soft delete
 *    once Phase 3 lands (S7).
 * 2. **`CommonMiddleware`'s `APPEND_SLASH`.** `settings.APPEND_SLASH` is Django's default
 *    (`True`; v1 never overrides it), so a non-matching path whose slashed form *does* match
 *    is a **301**, not a 404. That is the only reason `POST /password_reset` reaches
 *    `PasswordResetView` at all.
 * 3. **DRF's `default_response_headers`.** The matched view's `Allow` and `Vary: Accept` are
 *    attached here rather than in a controller, because in v1 they are on the 401 and 403 the
 *    *guards* produce, long before a handler runs (F4).
 *
 * ## Fail-closed
 *
 * A path absent from the table cannot reach a controller — plan §4 rule 3, applied to URLs
 * rather than to roles. Adding a route in Phases 3-8 therefore means adding its v1 pattern to
 * the table; forgetting produces an immediate, obvious 404 in that phase's own tests rather
 * than a silently wider surface than v1.
 */
@Injectable()
export class DjangoUrlResolverMiddleware implements NestMiddleware {
  constructor(
    @Inject(DJANGO_URL_CONF_TOKEN) private readonly urlConf: readonly DjangoUrlPattern[],
  ) {}

  use(request: Request, response: Response, next: NextFunction): void {
    const pathInfo = decodePathInfo(pathOf(request));
    const matched = resolveDjangoUrl(pathInfo, this.urlConf);

    if (matched === null) {
      if (this.shouldRedirectWithSlash(pathInfo)) {
        this.redirectWithSlash(request, response, pathInfo);
        return;
      }
      this.notFound(response);
      return;
    }

    this.applyDrfViewHeaders(response, matched);
    next();
  }

  /**
   * `CommonMiddleware.get_full_path_with_slash` → `HttpResponsePermanentRedirect`.
   *
   * `CommonMiddleware` sits **above** `CorsMiddleware` and `XFrameOptionsMiddleware` in v1's
   * `MIDDLEWARE`, so it builds this response after their response phases have already run:
   * the 301 carries no `Vary`, no `X-Frame-Options` and no `Access-Control-*` — verified live,
   * including with an `Origin` header. {@link skipBeforeHeadersHooks} reproduces that.
   *
   * ⚠️ In `DEBUG` mode Django raises `RuntimeError` for a POST/PUT/PATCH here instead of
   * redirecting. v1 deploys with `DEBUG = False` (`api/settings/production.py:16`), so the
   * 301 is the production behaviour for **every** method, verified with `POST`.
   *
   * ⚠️ `Location` is **not** the request target with a slash on the end — parity finding
   * **N2**, condition **C16**. Django builds it from `request.get_full_path(
   * force_append_slash=True)`, i.e. `escape_uri_path(PATH_INFO) + '/' + '?' +
   * iri_to_uri(QUERY_STRING)`: the *decoded* path, re-encoded. The comment this replaces
   * claimed the two agree "for every path that can reach this branch"; the **routes** are
   * ASCII, the **request target** need not be, and v1 answers `POST /password%5Freset` with
   * `Location: /password_reset/` where v2 answered `/password%5Freset/`.
   */
  private redirectWithSlash(request: Request, response: Response, pathInfo: string): void {
    skipBeforeHeadersHooks(response);
    const [, rawQuery] = splitQuery(request.originalUrl);
    const query = rawQuery === '' ? '' : `?${iriToUri(rawQuery.slice(1))}`;
    const location = escapeLeadingSlashes(`${escapeUriPath(pathInfo)}/${query}`);
    response.removeHeader('X-Powered-By');
    response.statusCode = 301;
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.setHeader('Location', location);
    response.setHeader('Content-Length', '0');
    response.end();
  }

  /**
   * Django's resolver 404. The body is v2's registered JSON shape rather than Django's HTML
   * error page (**D13**) and is rendered here, identically to what `ApiExceptionFilter`
   * produces for a `NotFoundException` — an exception thrown from Express middleware would
   * bypass Nest's filter chain entirely.
   */
  private notFound(response: Response): void {
    response.status(404).json({ message: 'Not Found' });
  }

  /**
   * `should_redirect_with_slash`: `APPEND_SLASH` is on, the path does not already end in `/`,
   * it does not resolve, and the slashed form does.
   */
  private shouldRedirectWithSlash(pathInfo: string): boolean {
    return !pathInfo.endsWith('/') && resolveDjangoUrl(`${pathInfo}/`, this.urlConf) !== null;
  }

  /** `APIView.default_response_headers`, minus what Django's 500 handler throws away. */
  private applyDrfViewHeaders(response: Response, matched: DjangoUrlPattern): void {
    const drf = matched.drf;
    if (drf === null) {
      return;
    }

    response.setHeader('Allow', drf.allow);
    if (drf.varyAccept) {
      patchVaryHeaders(response, ['Accept']);
    }

    onBeforeHeaders(response, (finished) => {
      // An unhandled exception never reaches `finalize_response`: Django builds a fresh
      // `HttpResponse` for the 500 and DRF's headers are lost with the old one. Verified —
      // v1's 500 carries `Vary: Origin` and `X-Frame-Options` (added later, by the
      // response middlewares) but neither `Allow` nor `Accept` in `Vary`.
      if (finished.statusCode >= 500) {
        finished.removeHeader('Allow');
        removeVaryField(finished, 'Accept');
      }
    });
  }
}

/** The raw (still percent-encoded) path, as Django's `get_full_path` reassembles it. */
function pathOf(request: Request): string {
  return splitQuery(request.originalUrl)[0];
}

function splitQuery(url: string): [path: string, query: string] {
  const index = url.indexOf('?');
  return index === -1 ? [url, ''] : [url.slice(0, index), url.slice(index)];
}

/** Drops one field from an already-merged `Vary`, leaving the rest in order. */
function removeVaryField(response: Response, field: string): void {
  const current = response.getHeader('Vary');
  if (current === undefined) {
    return;
  }
  const remaining = String(current)
    .split(',')
    .map((each) => each.trim())
    .filter((each) => each.length > 0 && each.toLowerCase() !== field.toLowerCase());

  if (remaining.length === 0) {
    response.removeHeader('Vary');
    return;
  }
  response.setHeader('Vary', remaining.join(', '));
}
