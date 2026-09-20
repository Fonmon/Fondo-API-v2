import type { Response } from 'express';

/**
 * Marks a response as one **DRF built**, i.e. one that went through
 * `APIView.finalize_response` — as opposed to one Django's exception handler built from
 * scratch after the view raised.
 *
 * ## Why the distinction is observable
 *
 * `DjangoUrlResolverMiddleware` attaches DRF's `default_response_headers` (`Allow`, and
 * `Vary: Accept` for a view with more than one renderer) to every response on a DRF route,
 * because DRF attaches them in `APIView.initial()` — before the handler runs — and they
 * therefore survive onto the 401s and 403s raised from there.
 *
 * A **500** is where the two paths separate, and v1 has one of each:
 *
 * ```
 * POST /api/user/power  {"type":"get","obj":"requested","page":0}   (UserAppsView catches it)
 *   HTTP/1.1 500 Internal Server Error
 *   Vary: Accept, Origin
 *   Allow: POST, OPTIONS            <- DRF's Response(status=500), finalize_response ran
 *   Content-Length: 0
 *
 * GET /api/user?page=abc                                            (nothing catches it)
 *   HTTP/1.1 500 Internal Server Error
 *   Content-Type: text/html
 *   Vary: Origin                    <- no Allow, no Accept: Django threw the response away
 *   Content-Length: 27
 * ```
 *
 * Both measured on the live v1 (gunicorn, `api.settings.production`). The second is
 * `convert_exception_to_response` building a fresh `HttpResponse` around
 * `BaseHandler._get_response`: DRF's headers were on the response object that no longer
 * exists. The first never left DRF.
 *
 * Parity finding **F1** of `docs/parity-phase-3.md` is exactly this: v2 stripped `Allow` and
 * `Vary: Accept` from *every* 500, so `UserAppsView`'s deliberate `Response(status=500)` —
 * reached by seven different inputs — lost two headers it keeps in v1.
 *
 * `ApiExceptionFilter` marks the responses it renders from an `ApiException` or a
 * `DrfException`, both of which are ports of a DRF `Response`; anything reaching the
 * filter's catch-all is an unhandled exception and stays unmarked.
 */
const DRF_RENDERED = Symbol('drfFinalizeResponse');

/** Records that this response is a rendered DRF `Response`, not Django's 500 handler's. */
export function markDrfRendered(response: Response): void {
  (response as unknown as Record<symbol, unknown>)[DRF_RENDERED] = true;
}

/** Whether {@link markDrfRendered} was called for this response. */
export function isDrfRendered(response: Response): boolean {
  return (response as unknown as Record<symbol, unknown>)[DRF_RENDERED] === true;
}
