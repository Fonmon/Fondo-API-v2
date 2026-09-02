import { Inject, Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { DjangoStack, onBeforeHeaders } from './before-headers';
import { patchVaryHeaders } from './django-cors.middleware';
import {
  DJANGO_URL_CONF_TOKEN,
  decodePathInfo,
  resolveDjangoUrl,
  type DjangoUrlPattern,
  type RequestWithDjangoRoute,
} from './django-url-conf';
import { isDrfRendered } from './drf-finalize-response';
import { escapeUriPath } from './django-uri-encoding';
import { splitQuery } from './request-target';

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
 * 2. **Dispatch on `PATH_INFO`, not on the request target** — finding **N3**, condition
 *    **C17**. Django routes on the decoded path, so `POST /api%2Dtoken%2Dauth` reaches
 *    `ObtainAuthToken` and `POST /api/%6Eotification/subscribe` reaches `NotificationView`.
 *    Express's router matches *literal* segments against the raw target (it only decodes
 *    captured params), so both were 404s in v2 — resolved by this table and then dropped by
 *    the router. {@link normaliseRequestTarget} closes that gap for every phase at once.
 * 3. **DRF's `default_response_headers`.** The matched view's `Allow` and `Vary: Accept` are
 *    attached here rather than in a controller, because in v1 they are on the 401 and 403 the
 *    *guards* produce, long before a handler runs (F4).
 * 4. **The matched view's identity**, published on the request as `djangoRoute` — condition
 *    **C20**, finding **S2**. Resolving *whether* a path is served is only half of what
 *    Django's resolver does; the other half is *which view* answers, and that is the key
 *    `fondo_api/permissions.py:list_permissions` is indexed by. Before this, the table
 *    computed the answer and threw it away, and `RolesGuard` re-derived it from whichever
 *    Nest route Express's declaration order had matched — two mappings with nothing keeping
 *    them in agreement. See {@link RequestWithDjangoRoute} for the `/api/user/<x>` case where
 *    they can disagree, and `RolesGuard` for what happens when they do.
 *
 * `CommonMiddleware`'s `APPEND_SLASH` 301 is **not** here: it belongs three middlewares above
 * the CORS short-circuit while resolution belongs below it, so it lives in
 * {@link DjangoAppendSlashMiddleware} (finding N1).
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
    const [rawPath, rawQuery] = splitQuery(request.originalUrl);
    const pathInfo = decodePathInfo(rawPath);
    const matched = resolveDjangoUrl(pathInfo, this.urlConf);

    if (matched === null) {
      this.notFound(response);
      return;
    }

    // Django's resolver answers "which view", not just "is this served" (C20). Everything
    // downstream — the guards especially — must key on *this*, not on the Nest route.
    (request as Request & RequestWithDjangoRoute).djangoRoute = matched;

    // `matched.dispatch` is the escape hatch for the one place Express cannot express
    // Django's discrimination — the `/api/user/<app|id>` collision. See
    // `DjangoUrlPattern.dispatch`.
    normaliseRequestTarget(request, matched.dispatch?.(pathInfo) ?? pathInfo, rawQuery);
    this.applyDrfViewHeaders(response, matched);
    next();
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

    // `DjangoStack.VIEW`: replacing the response for a 500 happens in
    // `convert_exception_to_response` around `_get_response`, below all eight middlewares —
    // so the strip must run *before* slot 8 patches `Vary: Origin` onto it (C21). Same depth
    // as `normaliseDrfContentType`, and disjoint from it: this touches `Allow` and `Vary`,
    // that one touches `Content-Type`.
    onBeforeHeaders(response, DjangoStack.VIEW, (finished) => {
      // An **unhandled** exception never reaches `finalize_response`: Django builds a fresh
      // `HttpResponse` for the 500 and DRF's headers are lost with the old one. Verified —
      // `GET /api/user?page=abc` carries `Vary: Origin` and `X-Frame-Options` (added later,
      // by the response middlewares) but neither `Allow` nor `Accept` in `Vary`.
      //
      // ⚠️ A 500 a DRF view **returns** is the opposite case and must keep both. v1 has one:
      // `UserAppsView.post`'s `except Exception: return Response(status=500)`, which
      // `finalize_response` renders like any other DRF response —
      // `Vary: Accept, Origin` and `Allow: POST, OPTIONS`, measured. Stripping on the status
      // code alone conflated the two and lost those headers on seven different inputs
      // (parity finding **F1**), so the test is "did Django throw this response away", not
      // "is it a 500".
      if (finished.statusCode >= 500 && !isDrfRendered(finished)) {
        finished.removeHeader('Allow');
        removeVaryField(finished, 'Accept');
      }
    });
  }
}

/**
 * Hands Nest's router the path Django dispatches on — `PATH_INFO`, decoded — instead of the
 * raw request target (finding **N3**).
 *
 * Re-encoded with `escape_uri_path` rather than inlined raw, because Express decodes captured
 * params with `decodeURIComponent`: a decoded segment must go back on the wire as a URL for
 * the router's own decoding to be a no-op. For every target that resolves against v1's table
 * the two forms are identical anyway — the patterns admit only `[0-9A-Za-z_-]`, so a resolving
 * `PATH_INFO` has nothing to escape — but a future pattern with a looser character class would
 * otherwise hand the router a `%`, a `?` or a `#` in a segment.
 *
 * A pattern carrying a `dispatch` hands the router that function's output instead — the only
 * case where `req.url`'s path is not v1's `PATH_INFO`, and the reason is the same one N3 gives
 * for rewriting at all: Nest's router has to be told what Django's resolver already decided.
 *
 * `originalUrl` keeps the raw target for logging; only `url`, which the router reads, moves.
 * The query string is passed through untouched: Django hands `QUERY_STRING` to `QueryDict`
 * still encoded, exactly as Express hands `req.url`'s query to its own parser.
 *
 * ⚠️ This works only because `AppModule` mounts its middleware at `/`. Under any other mount
 * path Express trims the matched prefix from `req.url` and restores it by *prepending* the
 * removed prefix on `next()`, which would splice the rewritten path onto the raw one.
 */
function normaliseRequestTarget(request: Request, pathInfo: string, rawQuery: string): void {
  const target = escapeUriPath(pathInfo) + (rawQuery === '' ? '' : `?${rawQuery}`);
  if (request.url !== target) {
    request.url = target;
  }
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
