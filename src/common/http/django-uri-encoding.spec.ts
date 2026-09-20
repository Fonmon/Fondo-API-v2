import { escapeLeadingSlashes, escapeUriPath, iriToUri } from './django-uri-encoding';

/**
 * Every expectation here is the output of the **real** Django function, obtained by running
 * `escape_uri_path` / `iri_to_uri` / `escape_leading_slashes` inside the v1 container
 * (Django 2.2.27, CPython 3.9) over this exact corpus. Nothing below is derived from the
 * documentation — parity finding **N2**, condition **C16**.
 */
describe('escapeUriPath — django.utils.encoding.escape_uri_path', () => {
  it.each([
    ['/password_reset', '/password_reset'],
    ['/api/notification/subscribe', '/api/notification/subscribe'],
    ['/a:@&+$,-_.!~*()x', '/a:@&+$,-_.!~*()x'],
    ["/a'b", "/a'b"],
  ])('leaves %s alone — every byte is in the safe set', (path, expected) => {
    expect(escapeUriPath(path)).toBe(expected);
  });

  it.each([
    ['/pass word_reset', '/pass%20word_reset'],
    ['/a%b', '/a%25b'],
    ['/a"b', '/a%22b'],
    ['/a<b>', '/a%3Cb%3E'],
    ['/a{b}|c\\d', '/a%7Bb%7D%7Cc%5Cd'],
    ['/a^b', '/a%5Eb'],
    ['/a`b', '/a%60b'],
    ['/a;b=c', '/a%3Bb%3Dc'],
    ['/a?b', '/a%3Fb'],
    ['/a#b', '/a%23b'],
    ['/a[b]', '/a%5Bb%5D'],
  ])('escapes the unsafe bytes of %s', (path, expected) => {
    expect(escapeUriPath(path)).toBe(expected);
  });

  it('UTF-8-encodes non-ASCII, one escape per byte, upper-case hex', () => {
    expect(escapeUriPath('/password_resetñ')).toBe('/password_reset%C3%B1');
    expect(escapeUriPath('/café/ñü')).toBe('/caf%C3%A9/%C3%B1%C3%BC');
    expect(escapeUriPath('/emoji\u{1F389}')).toBe('/emoji%F0%9F%8E%89');
  });

  it('escapes the U+FFFD that `decodePathInfo` leaves behind for an undecodable byte', () => {
    expect(escapeUriPath('/�')).toBe('/%EF%BF%BD');
  });

  it('never escapes `/` — it escapes a whole path, not a segment', () => {
    expect(escapeUriPath('//password_reset')).toBe('//password_reset');
  });

  it('differs from `encodeURI` and `encodeURIComponent`, which is why it is ported', () => {
    // `encodeURI` would leave `#`, `?`, `;`, `=` and `%` alone.
    expect(escapeUriPath('/a#b?c;d=e%f')).toBe('/a%23b%3Fc%3Bd%3De%25f');
    // `encodeURIComponent` would escape `/`, `:`, `@`, `&`, `+`, `$` and `,`.
    expect(escapeUriPath('/a:@&+$,b')).toBe('/a:@&+$,b');
  });
});

describe('iriToUri — django.utils.encoding.iri_to_uri (the QUERY_STRING half)', () => {
  it.each([
    ['a=%C3%B1&b=1', 'a=%C3%B1&b=1'],
    ['a=%zz', 'a=%zz'],
    ['x=%25', 'x=%25'],
    ['a=+b', 'a=+b'],
    ["a=~;#[]!?*@()$&:/'", "a=~;#[]!?*@()$&:/'"],
    ['', ''],
  ])('leaves %s untouched — `%%` is safe, per RFC 3987 §3.1', (query, expected) => {
    expect(iriToUri(query)).toBe(expected);
  });

  it.each([
    ['a=b c', 'a=b%20c'],
    ['a=ñ', 'a=%C3%B1'],
    ['a=1&b=<>"{}|\\^`', 'a=1&b=%3C%3E%22%7B%7D%7C%5C%5E%60'],
  ])('escapes the unsafe bytes of %s', (query, expected) => {
    expect(iriToUri(query)).toBe(expected);
  });
});

describe('escapeLeadingSlashes — django.utils.http.escape_leading_slashes', () => {
  it('escapes a doubled leading slash so the redirect cannot go schemaless', () => {
    expect(escapeLeadingSlashes('//x/')).toBe('/%2Fx/');
  });

  it('leaves a single leading slash alone', () => {
    expect(escapeLeadingSlashes('/x/')).toBe('/x/');
  });
});
