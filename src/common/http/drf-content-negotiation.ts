import { parseHeaderLatin1 } from './django-parse-header';
import { mediaTypeMatches } from './drf-media-type';

/**
 * Port of DRF's **response-side** content negotiation —
 * `rest_framework/negotiation.py::DefaultContentNegotiation.select_renderer`, plus the
 * `_MediaType` / `order_by_precedence` helpers in `rest_framework/utils/mediatypes.py` and
 * Django's `parse_header` (`django/http/multipartparser.py`).
 *
 * ## Why this is a control-flow port, not a rendering one — parity finding **F6**
 *
 * `APIView.initial()` (`rest_framework/views.py:398-414`) runs negotiation **first**:
 *
 * ```python
 * def initial(self, request, *args, **kwargs):
 *     self.format_kwarg = self.get_format_suffix(**kwargs)
 *     neg = self.perform_content_negotiation(request)          # <- 406 / 404 raised here
 *     request.accepted_renderer, request.accepted_media_type = neg
 *     version, scheme = self.determine_version(request, *args, **kwargs)
 *     request.version, request.versioning_scheme = version, scheme
 *     self.perform_authentication(request)                     # <- 401
 *     self.check_permissions(request)                          # <- 403
 *     self.check_throttles(request)
 * ```
 *
 * and `dispatch` only picks the handler *after* `initial()` returns — so the 406 also
 * precedes the **405**, the 415, the JSON parse 400 and every handler side effect. Measured
 * on the live v1 (`api.settings.production`, gunicorn), all zero-write:
 *
 * ```
 * GET  /api/user            Authorization: Token deadbeef   Accept: application/xml  -> 406 (401 under star/star)
 * GET  /api/user/activate/1                                 Accept: application/xml  -> 406 (405 under star/star)
 * POST /api/user/power      {"type":"get","obj":"requested","page":0}
 *                                                           Accept: application/xml  -> 406 (500 under star/star)
 * OPTIONS /api-token-auth                                   Accept: application/xml  -> 406 (200 under star/star)
 * ```
 *
 * The last row is the one that mattered: on a **write** endpoint v1 refuses before any side
 * effect, and v2 — which ignored `Accept` entirely — performed the write. That is the reason
 * this is implemented rather than registered as a body-rendering deviation.
 *
 * ## Two failure modes, not one
 *
 * `select_renderer` can also raise `Http404`, via `filter_renderers`: the
 * `URL_FORMAT_OVERRIDE` query parameter (`?format=…`, DRF's default name) narrows the
 * renderer list by `renderer.format`, and an empty list is a **404**, not a 406. Verified
 * live and *not* reported by round 2:
 *
 * ```
 * GET /api/user?format=xml   Authorization: Token deadbeef  -> 404 {"detail":"Not found."}   (v2 was 200)
 * GET /api/user?format=json  Accept: application/xml        -> 406   (the filter narrows, then the Accept fails)
 * POST /api-token-auth?format=api                           -> 404   (that view has only JSONRenderer)
 * ```
 *
 * `?format=api` on a view that *does* have `BrowsableAPIRenderer` selects it and renders the
 * browsable HTML page — the residual registered as **P3-D8**, which this module deliberately
 * does not implement: {@link BROWSABLE_API_RENDERER} is present so that negotiation
 * *succeeds* where v1's succeeds, and v2 then answers JSON.
 */

/** One entry of `renderer_classes`, reduced to the two attributes negotiation reads. */
export interface DrfRenderer {
  /** `BaseRenderer.media_type`, matched against the `Accept` header. */
  readonly mediaType: string;
  /** `BaseRenderer.format`, matched against `?format=`. */
  readonly format: string;
}

/** `rest_framework.renderers.JSONRenderer` — the only renderer v2 implements. */
export const JSON_RENDERER: DrfRenderer = Object.freeze({
  mediaType: 'application/json',
  format: 'json',
});

/**
 * `rest_framework.renderers.BrowsableAPIRenderer` (`renderers.py:379-380`).
 *
 * Listed so that negotiation reaches the same *decision* v1 reaches; the HTML page it would
 * render is **P3-D8**, and v2 answers JSON in its place.
 */
export const BROWSABLE_API_RENDERER: DrfRenderer = Object.freeze({
  mediaType: 'text/html',
  format: 'api',
});

/**
 * `api_settings.DEFAULT_RENDERER_CLASSES` — DRF's default, which v1 does not override
 * (`api/settings/base.py:87-98` sets only permissions, authentication and
 * `TEST_REQUEST_DEFAULT_FORMAT`).
 */
export const DEFAULT_RENDERERS: readonly DrfRenderer[] = Object.freeze([
  JSON_RENDERER,
  BROWSABLE_API_RENDERER,
]);

/**
 * `ObtainAuthToken.renderer_classes = (renderers.JSONRenderer,)`
 * (`rest_framework/authtoken/views.py:14`) — the one view in v1 that narrows the list, which
 * is why `POST /api-token-auth` with `Accept: text/html` is a 406 while the same header on
 * `GET /api/user` is a browsable-API page.
 */
export const JSON_ONLY_RENDERERS: readonly DrfRenderer[] = Object.freeze([JSON_RENDERER]);

/** What {@link selectRenderer} decided. */
export type NegotiationOutcome =
  | {
      readonly kind: 'selected';
      readonly renderer: DrfRenderer;
      /** `request.accepted_media_type`. Unused by v2's single renderer; see P3-D8. */
      readonly acceptedMediaType: string;
    }
  /** `filter_renderers` found no renderer with that `?format=` → `Http404`. */
  | { readonly kind: 'not-found' }
  /** No renderer matched the `Accept` header → `exceptions.NotAcceptable`. */
  | { readonly kind: 'not-acceptable' };

/**
 * `DefaultContentNegotiation.select_renderer`.
 *
 * @param acceptHeader the raw `Accept` header, or `undefined` when the client sent none.
 *   DRF reads `request.META.get('HTTP_ACCEPT', <star/star>)`, so *absent* is the wildcard and **empty**
 *   is the empty string — which matches no renderer and is a 406. Verified live: `curl -H
 *   'Accept;'` (an empty header, as opposed to curl's header-removing `-H 'Accept:'`) is a
 *   406 on v1 and was a 400 on v2.
 * @param format the `?format=` value, or `null` when the parameter is absent. An **empty**
 *   value is falsy in Python and disables the filter, so pass `''` and it will be ignored —
 *   verified live (`?format=` behaves exactly like no parameter).
 * @param renderers the view's `renderer_classes`, in declaration order. Order is
 *   load-bearing: the renderer loop is outside the media-type loop, so with
 *   `Accept: application/json;q=0.1,text/html;q=0.9` **JSON** wins — DRF sorts by
 *   *specificity*, never by `q`.
 */
export function selectRenderer(
  acceptHeader: string | undefined,
  format: string | null,
  renderers: readonly DrfRenderer[],
): NegotiationOutcome {
  let candidates = renderers;

  // `format = format_suffix or request.query_params.get(format_query_param)`; v1 has no
  // format suffix in any `url()`, so only the query parameter can be set.
  if (format !== null && format !== '') {
    candidates = renderers.filter((renderer) => renderer.format === format);
    if (candidates.length === 0) {
      return NOT_FOUND;
    }
  }

  for (const mediaTypeSet of orderByPrecedence(getAcceptList(acceptHeader))) {
    for (const renderer of candidates) {
      for (const mediaType of mediaTypeSet) {
        if (!mediaTypeMatches(renderer.mediaType, mediaType)) {
          continue;
        }
        const requested = parseMediaType(mediaType);
        if (parseMediaType(renderer.mediaType).precedence > requested.precedence) {
          // e.g. the client asked for `*/*;q=0.8`; DRF reports the *renderer's* media type
          // with the request's parameters glued back on.
          const params = [...requested.params].map(([key, value]) => `${key}=${value}`);
          return {
            kind: 'selected',
            renderer,
            acceptedMediaType: [renderer.mediaType, ...params].join(';'),
          };
        }
        return { kind: 'selected', renderer, acceptedMediaType: mediaType };
      }
    }
  }

  return NOT_ACCEPTABLE;
}

const NOT_FOUND: NegotiationOutcome = Object.freeze({ kind: 'not-found' as const });
const NOT_ACCEPTABLE: NegotiationOutcome = Object.freeze({ kind: 'not-acceptable' as const });

/**
 * `get_accept_list`: `[token.strip() for token in header.split(',')]`, with the wildcard `star/star` when the
 * header is absent. Note there is no filtering of empty tokens — `Accept: ,` yields two
 * empty strings, neither of which matches any renderer, and v1 answers **406** (verified).
 */
export function getAcceptList(acceptHeader: string | undefined): readonly string[] {
  const header = acceptHeader ?? '*/*';
  return header.split(',').map((token) => token.trim());
}

/**
 * `order_by_precedence` — group by how specific each media type is, most specific first.
 *
 * ⚠️ One intentional deviation, and it is unobservable: DRF groups into Python **sets**, so
 * two media types of the same precedence that match the same renderer are tried in
 * hash order and the *reported* `accepted_media_type` can differ between runs
 * (`Accept: application/json;a=1, application/json;b=2`). This keeps input order, which is
 * deterministic. Only `accepted_media_type` can differ, never the selected renderer, and v2
 * does not use `accepted_media_type` for anything — its single renderer takes its
 * `Content-Type` from `renderer.media_type` (`Response.rendered_content`, verified: v1
 * answers `Content-Type: application/json` even for `Accept: application/json;indent=8`).
 */
export function orderByPrecedence(mediaTypes: readonly string[]): readonly (readonly string[])[] {
  const buckets: string[][] = [[], [], [], []];
  for (const mediaType of mediaTypes) {
    const bucket = buckets[3 - parseMediaType(mediaType).precedence];
    // `set.add` — a duplicate media type is stored once. Keeps the loop faithful for
    // `Accept: application/json, application/json`.
    if (bucket !== undefined && !bucket.includes(mediaType)) {
      bucket.push(mediaType);
    }
  }
  return buckets.filter((bucket) => bucket.length > 0);
}

/** `_MediaType`, reduced to what negotiation reads. */
export interface ParsedMediaType {
  readonly fullType: string;
  readonly params: ReadonlyMap<string, string>;
  /** `_MediaType.precedence` — 0 for `star/star`, 1 for `type/star`, 2 for `type/sub`, 3 with params. */
  readonly precedence: number;
}

/**
 * `_MediaType.__init__` + `_MediaType.precedence`.
 *
 * The parameter split is Django's `parse_header`, shared with the multipart parser
 * ({@link parseHeaderLatin1}) rather than reimplemented — `_MediaType` literally imports it
 * from `django.http.multipartparser`. The detail that matters for negotiation is that a
 * parameter with no `=` is **dropped**, so `application/json;foo` is precedence 2 and still
 * matches `JSONRenderer`: v1 answers 400, not 406 (verified live).
 */
export function parseMediaType(mediaType: string): ParsedMediaType {
  const { key, params } = parseHeaderLatin1(mediaType);
  const slash = key.indexOf('/');
  const mainType = slash < 0 ? key : key.slice(0, slash);
  const subType = slash < 0 ? '' : key.slice(slash + 1);

  return { fullType: key, params, precedence: precedenceOf(mainType, subType, params) };
}

function precedenceOf(
  mainType: string,
  subType: string,
  params: ReadonlyMap<string, string>,
): number {
  if (mainType === '*') {
    return 0;
  }
  if (subType === '*') {
    return 1;
  }
  const names = [...params.keys()];
  if (names.length === 0 || (names.length === 1 && names[0] === 'q')) {
    return 2;
  }
  return 3;
}

/**
 * `request.query_params.get(URL_FORMAT_OVERRIDE)` — Django's `QueryDict.__getitem__` returns
 * the **last** value for a repeated key, which is observable: `?format=xml&format=json` is a
 * 400 on v1 and `?format=json&format=xml` a 404 (both verified live).
 *
 * @param rawQuery the query string without the leading `?`.
 * @returns the last `format` value, or `null` when the parameter is absent.
 */
export function formatQueryParam(rawQuery: string): string | null {
  if (rawQuery === '') {
    return null;
  }
  const values = new URLSearchParams(rawQuery).getAll(URL_FORMAT_OVERRIDE);
  return values.length === 0 ? null : (values[values.length - 1] ?? null);
}

/** `api_settings.URL_FORMAT_OVERRIDE`, DRF's default (`rest_framework/settings.py:96`). */
const URL_FORMAT_OVERRIDE = 'format';
