/**
 * `django.http.multipartparser.parse_header` and its `_parse_header_params` helper, ported
 * byte-exactly from the installed `Django==2.2.27`.
 *
 * One function, two very different callers, which is why it lives on its own:
 *
 *  * `rest_framework.utils.mediatypes._MediaType` imports it to split an `Accept` entry into
 *    a full type and its parameters — that is what decides a media type's *precedence*, and
 *    therefore whether a request is a **406** ({@link selectRenderer}, parity finding F6);
 *  * `django.http.multipartparser` calls it on the `Content-Type` request header (to find the
 *    `boundary`) and on every line of every multipart part header (to find `name` and
 *    `filename`) — parity finding **F8**.
 *
 * Both callers were reimplemented separately before this module existed and neither was
 * faithful: the media-type copy carried a `name.endswith('**')` branch from a *later* Django,
 * and the multipart side never called it at all (multer's own header parser stood in). The
 * two differences that actually bite:
 *
 *  * a parameter with **no `=`** is dropped entirely (`if i >= 0`), so
 *    `Accept: application/json;foo` has *no* parameters, precedence 2, and matches
 *    `JSONRenderer` — v1 answers 400, not 406 (verified live);
 *  * `;` inside a double-quoted value does **not** split, so
 *    `boundary="a;b"` is one parameter.
 *
 * ## Bytes, not strings
 *
 * Django's version takes and returns `bytes` for values (`str` only for the key and the
 * parameter names, both `.decode('ascii')`), because a multipart header can carry any byte
 * sequence and the charset is decided later by `force_text(..., encoding)`. This port keeps
 * that: {@link parseHeader} is the byte version, {@link parseHeaderLatin1} the convenience
 * wrapper for the `Accept` header, whose bytes `_MediaType` obtains with
 * `.encode(HTTP_HEADER_ENCODING)` — ISO-8859-1, which is also how Node hands header values
 * to JavaScript.
 *
 * ⚠️ Two faithfulness limits, both recorded rather than papered over:
 *  * Django does `key.decode('ascii')` / `name.decode('ascii')` with **strict** errors, so a
 *    non-ASCII byte there raises `UnicodeDecodeError` → 500. This port decodes with
 *    `latin1`, which cannot fail, so such a header parses instead of 500ing. Unreachable from
 *    an `Accept` header Node will accept, and it fails *open* only on a malformed header.
 *  * RFC 2231 `name*=utf-8''value` is decoded with `TextDecoder`, whose label set is not
 *    CPython's codec registry. An unknown charset label is a `LookupError` → 500 in v1; here
 *    it throws a `RangeError`, which reaches the same place.
 */

/** `bytes.strip()` — ASCII whitespace only, not Unicode. */
export function stripAsciiWhitespace(value: Buffer): Buffer {
  let start = 0;
  let end = value.length;
  while (start < end && ASCII_WHITESPACE.has(value[start] ?? -1)) {
    start += 1;
  }
  while (end > start && ASCII_WHITESPACE.has(value[end - 1] ?? -1)) {
    end -= 1;
  }
  return value.subarray(start, end);
}

/** `b' \t\n\r\x0b\x0c'`, the byte set `bytes.strip()` removes. */
const ASCII_WHITESPACE = new Set([0x20, 0x09, 0x0a, 0x0d, 0x0b, 0x0c]);

/** What {@link parseHeader} returns: `(key, pdict)`. */
export interface ParsedHeader {
  /** `plist.pop(0).lower()` — the media type or `name: value` pair, lowercased. */
  readonly key: string;
  /** Parameter names (lowercased ASCII) to their **undecoded** byte values. */
  readonly params: ReadonlyMap<string, Buffer>;
}

/**
 * ```python
 * def parse_header(line):
 *     plist = _parse_header_params(b';' + line)
 *     key = plist.pop(0).lower().decode('ascii')
 *     pdict = {}
 *     for p in plist:
 *         i = p.find(b'=')
 *         if i >= 0:
 *             has_encoding = False
 *             name = p[:i].strip().lower().decode('ascii')
 *             if name.endswith('*'):
 *                 name = name[:-1]
 *                 if p.count(b"'") == 2:
 *                     has_encoding = True
 *             value = p[i + 1:].strip()
 *             if has_encoding:
 *                 encoding, lang, value = value.split(b"'")
 *                 value = unquote(value.decode(), encoding=encoding.decode())
 *             if len(value) >= 2 and value[:1] == value[-1:] == b'"':
 *                 value = value[1:-1]
 *                 value = value.replace(b'\\\\', b'\\').replace(b'\\"', b'"')
 *             pdict[name] = value
 *     return key, pdict
 * ```
 */
export function parseHeader(line: Buffer): ParsedHeader {
  const parts = parseHeaderParams(Buffer.concat([SEMICOLON, line]));
  const first = parts.shift() ?? EMPTY;
  const key = first.toString('latin1').toLowerCase();
  const params = new Map<string, Buffer>();

  for (const part of parts) {
    const equals = part.indexOf(0x3d);
    if (equals < 0) {
      continue;
    }
    let hasEncoding = false;
    let name = stripAsciiWhitespace(part.subarray(0, equals)).toString('latin1').toLowerCase();
    if (name.endsWith('*')) {
      name = name.slice(0, -1);
      if (countByte(part, 0x27) === 2) {
        hasEncoding = true;
      }
    }
    let value = stripAsciiWhitespace(part.subarray(equals + 1));
    if (hasEncoding) {
      // `encoding, lang, value = value.split(b"'")` — exactly three fields, or `ValueError`.
      const fields = splitByte(value, 0x27);
      if (fields.length !== 3) {
        throw new TypeError(`too many values to unpack (expected 3)`);
      }
      const charset = (fields[0] ?? EMPTY).toString('latin1');
      value = Buffer.from(percentUnquote((fields[2] ?? EMPTY).toString('latin1'), charset), 'utf8');
    }
    if (value.length >= 2 && value[0] === 0x22 && value[value.length - 1] === 0x22) {
      value = Buffer.from(
        value.subarray(1, -1).toString('latin1').replace(/\\\\/g, '\\').replace(/\\"/g, '"'),
        'latin1',
      );
    }
    params.set(name, value);
  }

  return { key, params };
}

/**
 * {@link parseHeader} for a header value JavaScript already holds as a string.
 *
 * `_MediaType.__init__` does `parse_header(media_type_str.encode(HTTP_HEADER_ENCODING))`,
 * i.e. ISO-8859-1 — the same encoding Node uses when it turns header bytes into a string, so
 * the round trip is lossless.
 */
export function parseHeaderLatin1(line: string): {
  key: string;
  params: ReadonlyMap<string, string>;
} {
  const parsed = parseHeader(Buffer.from(line, 'latin1'));
  const params = new Map<string, string>();
  for (const [name, value] of parsed.params) {
    params.set(name, value.toString('latin1'));
  }
  return { key: parsed.key, params };
}

/**
 * ```python
 * def _parse_header_params(s):
 *     plist = []
 *     while s[:1] == b';':
 *         s = s[1:]
 *         end = s.find(b';')
 *         while end > 0 and s.count(b'"', 0, end) % 2:
 *             end = s.find(b';', end + 1)
 *         if end < 0:
 *             end = len(s)
 *         f = s[:end]
 *         plist.append(f.strip())
 *         s = s[end:]
 *     return plist
 * ```
 */
export function parseHeaderParams(value: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  let rest = value;

  while (rest[0] === 0x3b) {
    rest = rest.subarray(1);
    let end = rest.indexOf(0x3b);
    while (end > 0 && countByte(rest.subarray(0, end), 0x22) % 2 === 1) {
      end = rest.indexOf(0x3b, end + 1);
    }
    if (end < 0) {
      end = rest.length;
    }
    parts.push(stripAsciiWhitespace(rest.subarray(0, end)));
    rest = rest.subarray(end);
  }

  return parts;
}

function countByte(value: Buffer, byte: number): number {
  let count = 0;
  for (const current of value) {
    if (current === byte) {
      count += 1;
    }
  }
  return count;
}

function splitByte(value: Buffer, byte: number): Buffer[] {
  const fields: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === byte) {
      fields.push(value.subarray(start, index));
      start = index + 1;
    }
  }
  fields.push(value.subarray(start));
  return fields;
}

/**
 * `urllib.parse.unquote(string, encoding=<charset>, errors='replace')` — percent-decode to
 * bytes, then decode those bytes with the named charset, replacing what does not decode.
 */
function percentUnquote(value: string, charset: string): string {
  const decoder = new TextDecoder(charset === '' ? 'utf-8' : charset, { fatal: false });
  return value.replace(/(?:%[0-9A-Fa-f]{2})+/g, (escaped) => {
    const bytes = new Uint8Array(escaped.length / 3);
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Number.parseInt(escaped.slice(index * 3 + 1, index * 3 + 3), 16);
    }
    return decoder.decode(bytes);
  });
}

const SEMICOLON = Buffer.from(';');
const EMPTY = Buffer.alloc(0);
