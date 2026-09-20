/**
 * Port of DRF's request-side content negotiation — `rest_framework/request.py::Request._parse`
 * plus `rest_framework/utils/mediatypes.py::media_type_matches`.
 *
 * v1's `DEFAULT_PARSER_CLASSES` is DRF's default, `JSONParser + FormParser + MultiPartParser`
 * (`api/settings/base.py` leaves it unset), and two views narrow it with
 * `@parser_classes((MultiPartParser,))`: `UserView.patch` (`views/user.py:36`) and
 * `LoanView.patch` (`views/loan.py:49`), plus `FileView.post` (`views/file.py:15`).
 *
 * ```python
 * def select_parser(self, request, parsers):
 *     for parser in parsers:
 *         if media_type_matches(parser.media_type, request.content_type):
 *             return parser
 *     return None
 *
 * def negotiate_parser(self, stream, media_type):
 *     parser = self.negotiator.select_parser(self, self.parsers)
 *     if not parser:
 *         raise exceptions.UnsupportedMediaType(media_type)
 * ```
 */

/** The three parsers DRF installs by default, by their `media_type` attribute. */
export const DRF_PARSER_MEDIA_TYPES = {
  JSON: 'application/json',
  FORM: 'application/x-www-form-urlencoded',
  MULTIPART: 'multipart/form-data',
} as const;

export type DrfParserMediaType =
  (typeof DRF_PARSER_MEDIA_TYPES)[keyof typeof DRF_PARSER_MEDIA_TYPES];

/** `api_settings.DEFAULT_PARSER_CLASSES`, in DRF's order. */
export const DEFAULT_PARSER_MEDIA_TYPES: readonly DrfParserMediaType[] = [
  DRF_PARSER_MEDIA_TYPES.JSON,
  DRF_PARSER_MEDIA_TYPES.FORM,
  DRF_PARSER_MEDIA_TYPES.MULTIPART,
];

/** `_MediaType`: `full_type` split into main/sub, parameters dropped. */
function splitMediaType(value: string): { main: string; sub: string } {
  const fullType = (value.split(';')[0] ?? '').trim().toLowerCase();
  const slash = fullType.indexOf('/');
  if (slash < 0) {
    return { main: fullType, sub: '' };
  }
  return { main: fullType.slice(0, slash), sub: fullType.slice(slash + 1) };
}

/**
 * `media_type_matches(lhs, rhs)` — "true if `lhs` is *at least as specific as* `rhs`".
 *
 * The parameter comparison in `_MediaType.match` iterates over **lhs**'s parameters, and a
 * parser's `media_type` never carries any, so only the wildcard-aware main/sub comparison
 * survives. That is why `Content-Type: application/json; charset=utf-8` matches `JSONParser`,
 * and why a request whose content type is the bare wildcard (star slash star) is
 * parsed as JSON — the first parser in the list wins.
 */
export function mediaTypeMatches(parserMediaType: string, requestContentType: string): boolean {
  const lhs = splitMediaType(parserMediaType);
  const rhs = splitMediaType(requestContentType);
  if (lhs.sub !== '*' && rhs.sub !== '*' && rhs.sub !== lhs.sub) {
    return false;
  }
  return !(lhs.main !== '*' && rhs.main !== '*' && rhs.main !== lhs.main);
}

/**
 * `select_parser` — the first parser whose media type matches, or `null` for a 415.
 *
 * ⚠️ A request with **no** `Content-Type` header at all still reaches this in DRF: Django's
 * `request.content_type` is `''`, not `None`, so `_parse`'s `media_type is None` guard does
 * not fire and an empty content type 415s with `Unsupported media type "" in request.`
 * (verified against the pinned stack).
 */
export function selectParser(
  contentType: string,
  parsers: readonly DrfParserMediaType[] = DEFAULT_PARSER_MEDIA_TYPES,
): DrfParserMediaType | null {
  return parsers.find((parser) => mediaTypeMatches(parser, contentType)) ?? null;
}
