import { splitQuery } from './request-target';

/**
 * `splitQuery` against gunicorn's `split_request_uri` — finding **N4**, condition **C18**.
 *
 * Every expectation below was produced by running the *installed* gunicorn 19.9.0 in the image
 * v1 runs on the same target:
 *
 * ```
 * >>> from gunicorn.util import split_request_uri as s
 * >>> s('/password_reset?a=1#frag')
 * SplitResult(scheme='', netloc='', path='/password_reset', query='a=1', fragment='frag')
 * ```
 *
 * and cross-checked end to end over a raw socket against v1 on :8443, since supertest cannot
 * send a fragment (Node's client strips it before writing the request line). The raw-socket
 * results are pinned as the `Location` cells in `django-append-slash.middleware.spec.ts`.
 */
describe('splitQuery', () => {
  describe('the shapes that have no fragment (unchanged by N4)', () => {
    it.each([
      ['/password_reset', '/password_reset', ''],
      ['/password_reset/', '/password_reset/', ''],
      ['/password_reset?a=1', '/password_reset', 'a=1'],
      ['/password_reset?', '/password_reset', ''],
      ['/password_reset?a=1&b=2', '/password_reset', 'a=1&b=2'],
      ['/password_reset?a=1?b=2', '/password_reset', 'a=1?b=2'],
      ['', '', ''],
    ])('splits %s into %s + %s', (target, path, query) => {
      expect(splitQuery(target)).toEqual([path, query]);
    });
  });

  describe('N4 — the fragment is dropped before the path/query split', () => {
    it('drops a bare fragment, so the path still resolves', () => {
      // v1: POST /password_reset#frag -> 301 Location: /password_reset/
      // v2 before the fix: 404, because the path carried the `#frag`.
      expect(splitQuery('/password_reset#frag')).toEqual(['/password_reset', '']);
    });

    it('drops a fragment that follows a query, keeping the query itself', () => {
      // v1: POST /password_reset?a=1#frag -> 301 Location: /password_reset/?a=1
      // v2 before the fix: 301 Location: /password_reset/?a=1#frag — the fragment leaked
      // into the redirect target.
      expect(splitQuery('/password_reset?a=1#frag')).toEqual(['/password_reset', 'a=1']);
    });

    it('leaves a percent-encoded %23 alone — the control that the fix does not over-reach', () => {
      // v1: POST /password_reset%23frag -> 404, both before and after the fix. `%23` is not a
      // delimiter; PATH_INFO decodes to the literal `/password_reset#frag`, which is not a route.
      expect(splitQuery('/password_reset%23frag')).toEqual(['/password_reset%23frag', '']);
    });

    it('splits on the FIRST #, so a `?` after it belongs to the fragment', () => {
      // urlsplit removes the fragment before it looks for `?`, so this target has NO query.
      // v1: POST /password_reset#frag?a=1 -> 301 Location: /password_reset/ (no `?a=1`).
      expect(splitQuery('/password_reset#frag?a=1')).toEqual(['/password_reset', '']);
    });

    it('splits on the first # even when it sits inside the query', () => {
      // v1: POST /password_reset?a=1#f1#f2 -> 301 Location: /password_reset/?a=1
      expect(splitQuery('/password_reset?a=1#f1#f2')).toEqual(['/password_reset', 'a=1']);
    });

    it.each([
      ['/password_reset#', '/password_reset', ''],
      ['/password_reset?#', '/password_reset', ''],
      ['/password_reset?a=1#', '/password_reset', 'a=1'],
      ['#frag', '', ''],
      ['/a/b#f/g', '/a/b', ''],
    ])('handles the empty/degenerate fragment %s', (target, path, query) => {
      expect(splitQuery(target)).toEqual([path, query]);
    });
  });
});
