import { Inject, Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { onBeforeHeaders } from './before-headers';
import { patchVaryHeaders } from './django-cors.middleware';
import {
  DJANGO_URL_CONF_TOKEN,
  decodePathInfo,
  resolveDjangoUrl,
  type DjangoUrlPattern,
} from './django-url-conf';
import { splitQuery } from './request-target';

/**
 * Resolves the request against {@link DJANGO_URL_CONF} **before the guards**, exactly where
 * Django resolves it — review condition **C9**, parity findings **F2** and **P2-D5**.
 *
 * Two responsibilities, both of them Django's:
 *
 * 1. **`URLResolver.resolve`.** No pattern matches → 404, with no guard, no controller and no
 *    body parsing. This is what makes `POST /API/notification/subscribe` a 404 instead of a
 *    200-with-a-row (F2), `POST /api/notification/sub1` a 404 *before* authentication instead
 *    of a 401 (P2-D5), and `DELETE /api/user/5/` an inert 404 rather than a live soft delete
 *    once Phase 3 lands (S7).
 * 2. **DRF's `default_response_headers`.** The matched view's `Allow` and `Vary: Accept` are
 *    attached here rather than in a controller, because in v1 they are on the 401 and 403 the
 *    *guards* produce, long before a handler runs (F4).
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
    const [rawPath] = splitQuery(request.originalUrl);
    const pathInfo = decodePathInfo(rawPath);
    const matched = resolveDjangoUrl(pathInfo, this.urlConf);

    if (matched === null) {
      this.notFound(response);
      return;
    }

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
