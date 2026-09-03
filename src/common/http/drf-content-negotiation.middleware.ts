import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import {
  formatQueryParam,
  selectRenderer,
  type DrfRenderer,
  type NegotiationOutcome,
} from './drf-content-negotiation';
import type { RequestWithDjangoRoute } from './django-url-conf';
import { splitQuery } from './request-target';

/**
 * `APIView.initial()`'s first step, in the one place v2 can put it and still be before
 * authentication — parity finding **F6**.
 *
 * ## Placement
 *
 * v1's order inside `dispatch` is
 *
 * ```
 * initialize_request
 *   initial()  ->  perform_content_negotiation   406 / 404   <- this middleware
 *              ->  perform_authentication        401         <- TokenAuthGuard
 *              ->  check_permissions             403         <- RolesGuard
 *   handler    ->  request.data                  415 / 400   <- DrfParserInterceptor
 *              ->  the view body                 200 / 4xx / 500
 * ```
 *
 * so this has to run before the guards, and Nest runs **all** middleware before **all**
 * guards. It is registered directly after {@link DjangoUrlResolverMiddleware}, which is what
 * decides *which* view answers and therefore which `renderer_classes` apply — the same
 * dependency Django has, since `BaseHandler` resolves the URL before calling the view.
 *
 * A guard would have been the tidier Nest idiom and is the wrong tool here: `APP_GUARD`
 * providers execute in the order Nest happens to collect them across modules, so the
 * "negotiate before authenticate" ordering — which is the entire finding — would rest on
 * module resolution order. `AppModule.configure` states the middleware order explicitly.
 *
 * ## Why it must precede the guards, concretely
 *
 * Measured on the live v1, every one of these is a `406` where v2 answered the right-hand
 * status before this middleware existed:
 *
 * | request | `Accept: application/xml` | `Accept: star/star` |
 * |---|---|---|
 * | `GET /api/user` with a bad token | **406** | 401 |
 * | `GET /api/user/activate/1` | **406** | 405 |
 * | `OPTIONS /api-token-auth` | **406** | 200 metadata |
 * | `POST /api/user/power` `{"type":"get","obj":"requested","page":0}` | **406** | 500 |
 *
 * The consequence that made this worth implementing rather than registering: on a **write**
 * endpoint v1 refuses the request before any side effect and v2 performed it. A proxy or a
 * misconfigured client sending a single unacceptable `Accept` would mutate data against v2
 * that it could never have mutated against v1.
 *
 * ## Not applied to the plain Django routes
 *
 * `drf === null` in the URL table means the pattern resolves to a `django.contrib.auth` view
 * (the four password-reset pages) or to a v2-only route (`/health`). Those never construct a
 * DRF `Request` and ignore `Accept` entirely — 12/12 cells identical across `star/star`,
 * `text/html`, `application/xml` and `nonsense/nonsense` in round 2. This middleware skips
 * them for the same reason v1 does.
 */
@Injectable()
export class DrfContentNegotiationMiddleware implements NestMiddleware {
  use(request: Request, response: Response, next: NextFunction): void {
    const renderers = viewRenderers(request);
    if (renderers === null) {
      next();
      return;
    }

    const [, rawQuery] = splitQuery(request.originalUrl);
    const outcome = selectRenderer(request.headers.accept, formatQueryParam(rawQuery), renderers);

    switch (outcome.kind) {
      case 'selected':
        next();
        return;
      case 'not-found':
        // `filter_renderers` -> `Http404` -> DRF's `exception_handler` -> `NotFound`.
        this.render(response, 404, { detail: 'Not found.' });
        return;
      case 'not-acceptable':
        this.render(response, 406, { detail: 'Could not satisfy the request Accept header.' });
        return;
    }
  }

  /**
   * Both bodies are written here rather than thrown, because Express middleware runs outside
   * Nest's filter chain — the same reason {@link DjangoUrlResolverMiddleware} writes its own
   * 404. The `Allow` and `Vary: Accept` headers the resolver attached one middleware earlier
   * are already on the response, which is what v1 does too: `self.headers =
   * self.default_response_headers` is assigned in `dispatch` *before* `initial()` runs, so
   * the 406 carries them. Verified live — the 406 on `GET /api/user` has
   * `Allow: GET, POST, PATCH, HEAD, OPTIONS` and `Vary: Accept, Origin`.
   *
   * `Content-Type: application/json` with no charset comes from
   * `DjangoResponseHeadersMiddleware`'s `normaliseDrfContentType` hook, since
   * `Response.rendered_content` builds it from `renderer.media_type` and `JSONRenderer`
   * has `charset = None`.
   */
  private render(response: Response, status: number, body: Record<string, string>): void {
    response.status(status).json(body);
  }
}

/**
 * The `renderer_classes` of the view Django's resolver picked, or `null` when negotiation
 * does not apply.
 *
 * `undefined` `djangoRoute` means {@link DjangoUrlResolverMiddleware} did not run — only
 * possible in a test that assembles a partial module. Skipping is the safe reading (there is
 * no view, so there are no renderer classes); `test/content-negotiation.e2e-spec.ts` proves
 * the production wiring by driving the real `AppModule`.
 */
function viewRenderers(request: Request): readonly DrfRenderer[] | null {
  const route = (request as Request & RequestWithDjangoRoute).djangoRoute;
  return route?.drf?.renderers ?? null;
}

/** Re-exported so the middleware's own spec can assert on the outcome union. */
export type { NegotiationOutcome };
