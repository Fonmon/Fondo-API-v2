import {
  parseHeader,
  parseHeaderLatin1,
  parseHeaderParams,
  stripAsciiWhitespace,
} from './django-parse-header';

/**
 * Every expectation here was produced by running the function itself in the pinned v1
 * container:
 *
 * ```
 * docker exec fondo-v1-p3 python -c \
 *   "from django.http.multipartparser import parse_header; print(parse_header(b'...'))"
 * ```
 *
 * `parse_header` is shared by DRF's `_MediaType` (which decides a 406 — finding F6) and by
 * the multipart parser (which decides a 400 — finding F8), so the two callers cannot drift.
 */
describe('django.http.multipartparser.parse_header', () => {
  const parse = (line: string): { key: string; params: Record<string, string> } => {
    const result = parseHeader(Buffer.from(line, 'latin1'));
    const params: Record<string, string> = {};
    for (const [name, value] of result.params) {
      params[name] = value.toString('latin1');
    }
    return { key: result.key, params };
  };

  it('lowercases the key and keeps the parameter values as sent', () => {
    expect(parse('MultiPart/Form-Data; Boundary=AbC')).toEqual({
      key: 'multipart/form-data',
      params: { boundary: 'AbC' },
    });
  });

  it('drops a parameter with no `=` — `if i >= 0`', () => {
    // The reason `Accept: application/json;foo` is precedence 2 and not 3, so it still
    // matches JSONRenderer: v1 answers 400, not 406 (verified live).
    expect(parse('application/json;foo')).toEqual({ key: 'application/json', params: {} });
  });

  it('unquotes a double-quoted value and unescapes `\\\\` and `\\"`', () => {
    expect(parse('form-data; name="a\\"b"').params).toEqual({ name: 'a"b' });
    expect(parse('form-data; name="a\\\\b"').params).toEqual({ name: 'a\\b' });
  });

  it('does not split on a `;` inside a quoted value', () => {
    expect(parse('multipart/form-data; boundary="a;b"').params).toEqual({ boundary: 'a;b' });
  });

  it('keeps an empty parameter value, which is what makes `boundary=` a 400 and not a 500', () => {
    expect(parse('multipart/form-data; boundary=').params).toEqual({ boundary: '' });
  });

  it('reports no boundary at all when the parameter is absent', () => {
    // The `None.decode()` case: an AttributeError in v1, not a MultiPartParserError.
    expect(parseHeader(Buffer.from('multipart/form-data')).params.get('boundary')).toBeUndefined();
  });

  it('strips ASCII whitespace around names and values', () => {
    expect(parse('text/html ;  Q = 0.9 ').params).toEqual({ q: '0.9' });
  });

  it("decodes an RFC 2231 `name*=charset''value`", () => {
    // v1 stores the *decoded string* here rather than bytes; this port stores its UTF-8
    // encoding, which `force_text(..., 'utf-8')` at the use site turns back into the same
    // string. Asserting the decoded form is the assertion that matters.
    const filename = parseHeader(
      Buffer.from("form-data; filename*=utf-8''a%C3%B1o.txt"),
    ).params.get('filename');
    expect(filename?.toString('utf8')).toBe('año.txt');
  });

  it("strips one trailing `*` from a name even without an encoding (Django 2.2's branch)", () => {
    // Later Djangos added a `**` case; 2.2.27 always removes exactly one star.
    expect(parse('form-data; name*=plain').params).toEqual({ name: 'plain' });
  });

  describe('_parse_header_params', () => {
    it('returns the key first, then each stripped parameter', () => {
      expect(
        parseHeaderParams(Buffer.from(';a/b; c=1 ;d="x;y"')).map((part) => part.toString()),
      ).toEqual(['a/b', 'c=1', 'd="x;y"']);
    });

    it('returns nothing when the value does not start with `;`', () => {
      expect(parseHeaderParams(Buffer.from('a/b'))).toEqual([]);
    });
  });

  describe('bytes.strip', () => {
    it('removes only the six ASCII whitespace bytes', () => {
      expect(stripAsciiWhitespace(Buffer.from(' \t\r\n\x0b\x0cx \t')).toString()).toBe('x');
    });

    it('leaves a non-breaking space alone, unlike String.prototype.trim', () => {
      expect(stripAsciiWhitespace(Buffer.from([0xa0, 0x78, 0xa0])).toString('latin1')).toBe(' x ');
    });
  });

  describe('parseHeaderLatin1', () => {
    it('round-trips a header value Node already decoded as ISO-8859-1', () => {
      const { key, params } = parseHeaderLatin1('text/html; charset=é');
      expect(key).toBe('text/html');
      expect(params.get('charset')).toBe('é');
    });
  });
});
