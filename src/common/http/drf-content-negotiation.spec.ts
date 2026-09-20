import {
  BROWSABLE_API_RENDERER,
  DEFAULT_RENDERERS,
  JSON_ONLY_RENDERERS,
  JSON_RENDERER,
  formatQueryParam,
  getAcceptList,
  orderByPrecedence,
  parseMediaType,
  selectRenderer,
} from './drf-content-negotiation';

/**
 * Parity finding **F6** — `DefaultContentNegotiation.select_renderer`.
 *
 * Every expectation was measured against the live v1 (gunicorn, `api.settings.production`)
 * or produced by running the function itself in the pinned container. The statuses in the
 * comments are what a v1 route answered for that `Accept`; the point of the port is that the
 * decision happens in `APIView.initial()`, **before** authentication, permissions, the
 * handler and any write.
 */
describe('DefaultContentNegotiation.select_renderer', () => {
  const select = (accept: string | undefined, renderers = DEFAULT_RENDERERS): string =>
    describeOutcome(selectRenderer(accept, null, renderers));

  const describeOutcome = (outcome: ReturnType<typeof selectRenderer>): string =>
    outcome.kind === 'selected'
      ? `${outcome.renderer.format}:${outcome.acceptedMediaType}`
      : outcome.kind;

  describe('the renderers v1 declares', () => {
    it('is JSONRenderer + BrowsableAPIRenderer by default, JSONRenderer alone on ObtainAuthToken', () => {
      expect(DEFAULT_RENDERERS).toEqual([JSON_RENDERER, BROWSABLE_API_RENDERER]);
      expect(JSON_ONLY_RENDERERS).toEqual([JSON_RENDERER]);
      expect(JSON_RENDERER).toEqual({ mediaType: 'application/json', format: 'json' });
      expect(BROWSABLE_API_RENDERER).toEqual({ mediaType: 'text/html', format: 'api' });
    });
  });

  describe('the values that select JSON — identical on both stacks, 18/18 in round 2', () => {
    it.each([
      ['*/*', 'json:application/json'],
      ['application/json', 'json:application/json'],
      ['application/*', 'json:application/json'],
      ['application/json; charset=utf-8', 'json:application/json; charset=utf-8'],
      // A parameter with no `=` is dropped by `parse_header`, so this is precedence 2.
      ['application/json;foo', 'json:application/json;foo'],
      ['zzz, application/json', 'json:application/json'],
      [undefined, 'json:application/json'],
    ])('Accept: %p -> %p', (accept, expected) => {
      expect(select(accept)).toBe(expected);
    });

    it('sorts by SPECIFICITY, never by q — JSON wins over a higher-q text/html', () => {
      // Measured: `Accept: application/json;q=0.1,text/html;q=0.9` is JSON on v1, 9/9 cells.
      // Both entries are precedence 2, so they land in one bucket and the *renderer* loop —
      // which is outside the media-type loop — decides. JSONRenderer is declared first.
      expect(select('application/json;q=0.1,text/html;q=0.9')).toBe('json:application/json;q=0.1');
    });

    it("glues the request's parameters onto the renderer's media type for a wildcard", () => {
      // `if _MediaType(renderer.media_type).precedence > media_type_wrapper.precedence`.
      expect(select('*/*;q=0.8')).toBe('json:application/json;q=0.8');
    });
  });

  describe('the values that select the browsable renderer — registered as P3-D8', () => {
    it.each([
      ['text/html', 'api:text/html'],
      ['text/*', 'api:text/html'],
      [
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'api:text/html',
      ],
    ])('Accept: %p -> %p', (accept, expected) => {
      expect(select(accept)).toBe(expected);
    });

    it('but a real browser gets JSON from ObtainAuthToken, via its `*/*;q=0.8` tail', () => {
      expect(
        select(
          'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          JSON_ONLY_RENDERERS,
        ),
      ).toBe('json:application/json;q=0.8');
    });
  });

  describe('the values that are a 406 — the finding', () => {
    it.each(['application/xml', 'text/plain', 'nonsense/nonsense', ','])(
      'Accept: %p -> not-acceptable on a two-renderer view',
      (accept) => {
        expect(select(accept)).toBe('not-acceptable');
      },
    );

    it('an EMPTY Accept header is a 406, while an ABSENT one is `*/*`', () => {
      // `request.META.get('HTTP_ACCEPT', '*/*')` — absent takes the default, present-and-empty
      // does not. Measured live with `curl -H 'Accept;'`: 406 on v1, was 400 on v2.
      expect(select('')).toBe('not-acceptable');
      expect(select(undefined)).toBe('json:application/json');
    });

    it('`text/html` is a 406 on ObtainAuthToken, which declares only JSONRenderer', () => {
      expect(select('text/html', JSON_ONLY_RENDERERS)).toBe('not-acceptable');
      // Positive control: the same view answers `*/*`.
      expect(select('*/*', JSON_ONLY_RENDERERS)).toBe('json:application/json');
    });
  });

  describe('the `?format=` override — a 404, not a 406 (not reported in round 2)', () => {
    const withFormat = (format: string | null, renderers = DEFAULT_RENDERERS): string =>
      describeOutcome(selectRenderer('*/*', format, renderers));

    it('narrows to a renderer with that `format` attribute', () => {
      expect(withFormat('json')).toBe('json:application/json');
      expect(withFormat('api')).toBe('api:text/html');
    });

    it('is `Http404` when no renderer has that format — before authentication', () => {
      // Measured: `GET /api/user?format=xml` with a *bad* token is 404 on v1 (v2 was 200).
      expect(withFormat('xml')).toBe('not-found');
      // `html` is TemplateHTMLRenderer's format, and v1 installs neither of those.
      expect(withFormat('html')).toBe('not-found');
      expect(withFormat('api', JSON_ONLY_RENDERERS)).toBe('not-found');
    });

    it('is case sensitive', () => {
      expect(withFormat('JSON')).toBe('not-found');
    });

    it('an empty value is falsy in Python and disables the filter', () => {
      expect(withFormat('')).toBe('json:application/json');
      expect(withFormat(null)).toBe('json:application/json');
    });

    it('narrows first, then still negotiates — `?format=json` + `Accept: application/xml` is 406', () => {
      expect(describeOutcome(selectRenderer('application/xml', 'json', DEFAULT_RENDERERS))).toBe(
        'not-acceptable',
      );
    });
  });

  describe('formatQueryParam — QueryDict.__getitem__ keeps the LAST value', () => {
    it.each([
      ['', null],
      ['page=0', null],
      ['format=xml', 'xml'],
      ['format=', ''],
      // Measured live: `?format=xml&format=json` is 400 (the handler ran) and
      // `?format=json&format=xml` is 404.
      ['format=xml&format=json', 'json'],
      ['format=json&format=xml', 'xml'],
      ['format=js%6Fn', 'json'],
    ])('%p -> %p', (query, expected) => {
      expect(formatQueryParam(query)).toBe(expected);
    });
  });

  describe('the helpers, ported one for one', () => {
    it('get_accept_list splits on `,` and strips, defaulting to the wildcard', () => {
      expect(getAcceptList(undefined)).toEqual(['*/*']);
      expect(getAcceptList(' a/b , c/d ')).toEqual(['a/b', 'c/d']);
      // No empty-token filtering: `Accept: ,` is two empty strings, and a 406.
      expect(getAcceptList(',')).toEqual(['', '']);
    });

    it.each([
      ['*/*', 0],
      ['*/*;q=0.8', 0],
      ['text/*', 1],
      ['application/json', 2],
      ['application/json;q=0.9', 2],
      ['application/json;indent=8', 3],
      ['application/json;foo', 2],
      ['', 2],
    ])('_MediaType(%p).precedence === %p', (mediaType, expected) => {
      expect(parseMediaType(mediaType).precedence).toBe(expected);
    });

    it('order_by_precedence buckets most-specific first and drops empty buckets', () => {
      expect(orderByPrecedence(['*/*', 'text/*', 'a/b;x=1', 'c/d'])).toEqual([
        ['a/b;x=1'],
        ['c/d'],
        ['text/*'],
        ['*/*'],
      ]);
    });

    it('order_by_precedence de-duplicates, as Python`s set does', () => {
      expect(orderByPrecedence(['a/b', 'a/b'])).toEqual([['a/b']]);
    });
  });
});
