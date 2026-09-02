import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { DjangoStack, onBeforeHeaders } from './before-headers';

/**
 * Port of `corsheaders.middleware.CorsMiddleware` (django-cors-headers **2.4.0**, the version
 * pinned in v1's `requirements.txt`) under v1's settings — `CORS_ORIGIN_ALLOW_ALL = True` and
 * nothing else configured (`api/settings/base.py:38-49`).
 *
 * ## Why this replaces `app.enableCors()` — condition **C14**, parity finding **F1**
 *
 * `app.enableCors()` installs the `cors` package, which answers **every** `OPTIONS` request
 * with a 204 from middleware, with or without an `Origin` header, before the router, the
 * guards and the `@All()` fallback ever run. On a guarded route that is not a cosmetic
 * difference: a bare `OPTIONS /api/notification/subscribe` is **401 unauthenticated / 403 for
 * every role** in v1 and was **204 for anyone** in v2 — authentication and permissions were
 * bypassed on that verb.
 *
 * v1's asymmetry, which is the spec, comes straight from the source above:
 *
 * ```python
 * if (request.method == 'OPTIONS' and
 *         'HTTP_ACCESS_CONTROL_REQUEST_METHOD' in request.META):
 *     response = http.HttpResponse()
 *     response['Content-Length'] = '0'
 *     return response
 * ```
 *
 * * A **genuine preflight** — an `OPTIONS` carrying `Access-Control-Request-Method` — is
 *   short-circuited with an empty **200** before URL resolution. Note what is *not* in that
 *   condition: `Origin`. corsheaders 2.4.0 short-circuits on the request-method header alone,
 *   and it does so for **any** path, including one that does not resolve.
 * * **Any other `OPTIONS`** falls through to the view and is authenticated and
 *   permission-checked like any other method.
 *
 * Everything else here is `process_response`, reproduced through {@link onBeforeHeaders} so it
 * merges with the headers the handler set (`Vary: Accept` becomes `Vary: Accept, Origin`, as
 * in v1) instead of overwriting them:
 *
 * * `Vary: Origin` is patched onto **every** response — including 404s and 500s — because
 *   `patch_vary_headers` runs before the `if not origin: return response` early exit.
 * * `Access-Control-Allow-Origin: *` only when the request carries `Origin`
 *   (`CORS_ORIGIN_ALLOW_ALL and not CORS_ALLOW_CREDENTIALS` → the literal `*`).
 * * `Access-Control-Allow-Headers` / `-Methods` / `-Max-Age` on **any** `OPTIONS` response
 *   that carries an `Origin`, not just the short-circuited preflight — v1 puts them on the
 *   401 and 403 too (verified live).
 * * No `Access-Control-Allow-Credentials` (`CORS_ALLOW_CREDENTIALS` defaults to `False`) and
 *   no `Access-Control-Expose-Headers` (`CORS_EXPOSE_HEADERS` defaults to `()`).
 *
 * ⚠️ Registered as-is, not tightened: `CORS_ORIGIN_ALLOW_ALL = True` is v1's setting and
 * narrowing it to an allowlist is a product decision on the post-cutover backlog, not part of
 * this migration.
 */
@Injectable()
export class DjangoCorsMiddleware implements NestMiddleware {
  use(request: Request, response: Response, next: NextFunction): void {
    if (isPreflight(request)) {
      // `http.HttpResponse()` — Django's default: 200, `text/html; charset=utf-8`, empty body.
      response.statusCode = 200;
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      applyCorsResponseHeaders(request, response);
      // `X-Frame-Options` is added by `XFrameOptionsMiddleware`, whose response phase also
      // runs on the short-circuit. `DjangoResponseHeadersMiddleware` has already registered
      // its hook, so it lands on this response too.
      response.setHeader('Content-Length', '0');
      response.end();
      return;
    }

    // Slot 8: the deepest of v1's eight, so its response phase runs first of the eight and
    // `Vary: Origin` lands *after* anything the view added and *before* slots 7-1 (C21).
    onBeforeHeaders(response, DjangoStack.CORS, (finished) => {
      applyCorsResponseHeaders(request, finished);
    });
    next();
  }
}

/**
 * `request.method == 'OPTIONS' and 'HTTP_ACCESS_CONTROL_REQUEST_METHOD' in request.META`.
 *
 * Presence, not value: an empty `Access-Control-Request-Method:` header is still a key in
 * `META` and still short-circuits.
 */
function isPreflight(request: Request): boolean {
  return request.method === 'OPTIONS' && 'access-control-request-method' in request.headers;
}

/** `CorsMiddleware.process_response` with v1's settings inlined. */
function applyCorsResponseHeaders(request: Request, response: Response): void {
  // `patch_vary_headers(response, ['Origin'])` — unconditional, before the origin check.
  patchVaryHeaders(response, ['Origin']);

  const origin = request.headers.origin;
  if (origin === undefined) {
    return;
  }

  // `CORS_ORIGIN_ALLOW_ALL and not CORS_ALLOW_CREDENTIALS` → the literal `*`, not the origin.
  response.setHeader('Access-Control-Allow-Origin', '*');

  if (request.method === 'OPTIONS') {
    response.setHeader('Access-Control-Allow-Headers', CORS_ALLOW_HEADERS);
    response.setHeader('Access-Control-Allow-Methods', CORS_ALLOW_METHODS);
    response.setHeader('Access-Control-Max-Age', CORS_PREFLIGHT_MAX_AGE);
  }
}

/**
 * `django.utils.cache.patch_vary_headers` — adds field names to `Vary` without duplicating
 * them, case-insensitively, and collapses to `*` if either side is `*`.
 */
export function patchVaryHeaders(response: Response, newHeaders: readonly string[]): void {
  const current = response.getHeader('Vary');
  const existing =
    current === undefined
      ? []
      : String(current)
          .split(',')
          .map((field) => field.trim())
          .filter((field) => field.length > 0);

  if (existing.includes('*') || newHeaders.includes('*')) {
    response.setHeader('Vary', '*');
    return;
  }

  const seen = new Set(existing.map((field) => field.toLowerCase()));
  const merged = [...existing];
  for (const field of newHeaders) {
    if (!seen.has(field.toLowerCase())) {
      seen.add(field.toLowerCase());
      merged.push(field);
    }
  }
  response.setHeader('Vary', merged.join(', '));
}

/** `corsheaders.defaults.default_headers`, joined as `process_response` joins them. */
export const CORS_ALLOW_HEADERS =
  'accept, accept-encoding, authorization, content-type, dnt, origin, user-agent, ' +
  'x-csrftoken, x-requested-with';

/** `corsheaders.defaults.default_methods`. */
export const CORS_ALLOW_METHODS = 'DELETE, GET, OPTIONS, PATCH, POST, PUT';

/** `CORS_PREFLIGHT_MAX_AGE` default. Django renders the int; the header is a string. */
export const CORS_PREFLIGHT_MAX_AGE = '86400';
