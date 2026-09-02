import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { DjangoStack, onBeforeHeaders } from './before-headers';

/**
 * The rest of v1's response-header surface, in one place — parity finding **F4**.
 *
 * Four differences were measured against the live v1 and are closed here because each is
 * cheap and none changes a status or a body. What is **not** closed is registered in
 * `docs/phase-2-deviations.md` (P2-D8).
 *
 * | Header | v1 | v2 before | Here |
 * |---|---|---|---|
 * | `X-Frame-Options: SAMEORIGIN` | on every response | absent | `XFrameOptionsMiddleware` ported |
 * | `X-Powered-By: Express` | — | on every response | removed |
 * | `ETag` | — | on JSON error bodies | removed |
 * | `Content-Type` | `application/json`, and **absent** on a zero-byte DRF body | `application/json; charset=utf-8` on both | normalised |
 *
 * ## The two Content-Type rules are DRF's, not guesses
 *
 * `JSONRenderer.charset` is `None`, so `Response.rendered_content` builds the content type
 * from the media type alone — `application/json`, with no `; charset=utf-8`. Express's
 * `res.json()` appends the charset. And for an empty body:
 *
 * ```python
 * ret = renderer.render(self.data, accepted_media_type, context)
 * if not ret:
 *     del self['Content-Type']
 * ```
 *
 * so `Response(status=404)` — which `NotificationView` returns for an unknown endpoint, and
 * which Phases 3-8 return from a dozen handlers — carries **no** `Content-Type` at all.
 * Verified live on `POST /api/notification/unsubscribe` (404) and `.../suscribe` (405).
 *
 * ## Three hooks, three depths — condition **C21**
 *
 * The four rows above do not all live at the same place in v1's stack, and since the response
 * phase is ordered by depth they cannot be registered as one hook any more:
 *
 * | what | depth | why |
 * |---|---|---|
 * | `X-Frame-Options: SAMEORIGIN` | {@link DjangoStack.X_FRAME_OPTIONS} (7) | it *is* slot 7 |
 * | DRF's `Content-Type` rules | {@link DjangoStack.VIEW} | `Response.rendered_content`, below all eight |
 * | drop `X-Powered-By` / `ETag` | {@link DjangoStack.TRANSPORT} | not Django at all — undoing Express, above slot 1 so no short-circuit can skip it |
 *
 * Nothing observable changes today (the three touch disjoint headers, and the 500 fixup they
 * now interleave with only removes `Allow` and `Accept`), which is the point: the model is
 * made right while it is still cheap to check.
 *
 * ## Why a response hook rather than `app.disable(...)`
 *
 * `x-powered-by` and `etag` are Express *application* settings, and the only handle on the
 * application object is in `main.ts` — where the e2e suites, which build the app from
 * `AppModule`, would never see them. That gap is exactly how `app.enableCors()` shipped a
 * 204-for-everything `OPTIONS` (F1) through a green test suite. Everything that shapes a
 * response now lives in `AppModule`.
 */
@Injectable()
export class DjangoResponseHeadersMiddleware implements NestMiddleware {
  use(_request: Request, response: Response, next: NextFunction): void {
    onBeforeHeaders(response, DjangoStack.VIEW, normaliseDrfContentType);
    onBeforeHeaders(response, DjangoStack.X_FRAME_OPTIONS, applyXFrameOptions);
    onBeforeHeaders(response, DjangoStack.TRANSPORT, dropExpressHeaders);
    next();
  }
}

/**
 * `django.middleware.clickjacking.XFrameOptionsMiddleware` with `X_FRAME_OPTIONS` unset ->
 * its default, `SAMEORIGIN`. It never overwrites a header the view set.
 */
function applyXFrameOptions(response: Response): void {
  if (response.getHeader('X-Frame-Options') === undefined) {
    response.setHeader('X-Frame-Options', 'SAMEORIGIN');
  }
}

/** Headers v1 never emits because it is not Express. Not a ported middleware. */
function dropExpressHeaders(response: Response): void {
  response.removeHeader('X-Powered-By');
  response.removeHeader('ETag');
}

/** `Response.rendered_content`: `application/json` with no charset, and none at all if empty. */
function normaliseDrfContentType(response: Response): void {
  const contentType = response.getHeader('Content-Type');
  if (typeof contentType !== 'string' || !contentType.startsWith('application/json')) {
    return;
  }

  if (isEmptyBody(response)) {
    response.removeHeader('Content-Type');
    return;
  }

  response.setHeader('Content-Type', 'application/json');
}

function isEmptyBody(response: Response): boolean {
  const length = response.getHeader('Content-Length');
  return length !== undefined && Number(length) === 0;
}
