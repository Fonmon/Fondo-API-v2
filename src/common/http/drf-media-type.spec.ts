import {
  DEFAULT_PARSER_MEDIA_TYPES,
  DRF_PARSER_MEDIA_TYPES,
  mediaTypeMatches,
  selectParser,
} from './drf-media-type';

/**
 * §5 D18 / review finding S3 — the request-side negotiation half.
 *
 * Expectations were taken by driving `rest_framework.request.Request` with DRF 3.11.2's
 * `DEFAULT_PARSER_CLASSES` on the pinned stack; the transcript is in
 * `docs/phase-1-drf-auth-bodies.md` §6.
 */
describe('mediaTypeMatches — rest_framework/utils/mediatypes.py', () => {
  it.each([
    ['application/json', 'application/json', true],
    ['application/json', 'application/json; charset=utf-8', true],
    ['application/json', 'APPLICATION/JSON', true],
    ['application/json', 'application/xml', false],
    ['application/json', 'text/plain', false],
    ['application/json', '', false],
    // A request that sends a wildcard content type matches the first parser in the list.
    ['application/json', 'application/*', true],
    ['application/json', '*/*', true],
    ['multipart/form-data', 'multipart/form-data; boundary=xyz', true],
    ['application/x-www-form-urlencoded', 'application/x-www-form-urlencoded', true],
  ])('media_type_matches(%s, %s) === %s', (parser, requestType, expected) => {
    expect(mediaTypeMatches(parser, requestType)).toBe(expected);
  });
});

describe('selectParser — Request.negotiate_parser', () => {
  it('picks the parser DRF picks for each supported type', () => {
    expect(selectParser('application/json')).toBe(DRF_PARSER_MEDIA_TYPES.JSON);
    expect(selectParser('application/json; charset=utf-8')).toBe(DRF_PARSER_MEDIA_TYPES.JSON);
    expect(selectParser('application/x-www-form-urlencoded')).toBe(DRF_PARSER_MEDIA_TYPES.FORM);
    expect(selectParser('multipart/form-data; boundary=BoUnDaRy')).toBe(
      DRF_PARSER_MEDIA_TYPES.MULTIPART,
    );
  });

  it('returns null — a 415 — for a type no parser claims', () => {
    expect(selectParser('text/plain')).toBeNull();
    expect(selectParser('application/xml')).toBeNull();
    expect(selectParser('application/octet-stream')).toBeNull();
  });

  it('returns null for a missing Content-Type header', () => {
    // Django's `request.content_type` is '' (never None) when the header is absent, so
    // `_parse`'s `media_type is None` guard does not fire and a body sent without a
    // Content-Type 415s with `Unsupported media type "" in request.` — captured from the
    // pinned stack, where it raised `UnsupportedMediaType: Unsupported media type "" in request.`
    expect(selectParser('')).toBeNull();
  });

  it('honours a narrowed parser list, as @parser_classes((MultiPartParser,)) does', () => {
    // `views/user.py:36` and `views/loan.py:49` — the bulk TSV endpoints. A JSON body there
    // is a 415 in v1, not a 400.
    const multipartOnly = [DRF_PARSER_MEDIA_TYPES.MULTIPART];
    expect(selectParser('multipart/form-data; boundary=x', multipartOnly)).toBe(
      DRF_PARSER_MEDIA_TYPES.MULTIPART,
    );
    expect(selectParser('application/json', multipartOnly)).toBeNull();
  });

  it("defaults to DRF's three parsers, in DRF's order", () => {
    expect(DEFAULT_PARSER_MEDIA_TYPES).toEqual([
      'application/json',
      'application/x-www-form-urlencoded',
      'multipart/form-data',
    ]);
  });
});
