import { pythonRepr } from '../utils/python-str';

/**
 * gunicorn 19.9.0's request-line parser, and the error page it writes when the line is
 * rejected — the layer **below** Django that v2 had no equivalent of at all.
 *
 * ## Why this exists (parity finding N1)
 *
 * v1 is gunicorn 19.9.0 in front of Django. gunicorn validates the request line itself and
 * passes everything that survives to the WSGI app, whatever the method token says. Node's
 * `llhttp` instead accepts a **fixed table** of method names and rejects the request before
 * Express is ever called, so v2 answered a bare `400 Bad Request` — or, for `CONNECT`,
 * nothing at all — where v1 answers the ordinary 401/403/404 of the matched view.
 *
 * Measured on the wire against the pinned v1 (`fondo-v1-p4`, gunicorn 19.9.0,
 * `Host: localhost`, `GET`-equivalent target `/api/activity/year`, unauthenticated):
 *
 * | request line | v1 |
 * |---|---|
 * | `FROB /api/activity/year HTTP/1.1` | **401** `{"detail":"Authentication credentials were not provided."}` |
 * | `CONNECT …`, `BREW …`, `ABC …`, `A-C …`, `A_C …`, `A.C …`, `A$C …` | **401**, identical bytes |
 * | `FROBNICATORFROBNICATOR12 …` (24 chars) | **401** — `re.match` is a *prefix* match, so `{3,20}` sets no upper bound |
 * | `FROB\t…\tHTTP/1.1`, `FROB␠␠␠…` | **401** — `split(None, 2)` eats runs of whitespace |
 * | `FROB /nope HTTP/1.1` | **404**, Django's HTML page (**D13**) |
 * | `X …`, `AB …`, `get …`, `Get …`, `FR OB …` | **400**, gunicorn's own 182–184-byte HTML page |
 * | `FROB /api/activity/year` (two bits) | **400**, `Invalid Request Line …` |
 * | `FROB … HTTP/9`, `FROB … http/1.1` | **400**, `Invalid HTTP Version …` |
 *
 * The split is entirely `METH_RE` + the three-bit rule + `VERSION_RE`: what passes reaches
 * the view and is authenticated and permission-checked like any other method token (no
 * permission-map entry ⇒ 403, exactly as `OPTIONS` and `PUT` already are, rule 13); what
 * fails gets `gunicorn.util.write_error`'s page, which carries **no `Server` and no `Date`
 * header** because it is written straight onto the socket before a `Response` exists.
 *
 * ## Fidelity notes
 *
 * * `METH_RE`/`VERSION_RE` are gunicorn's patterns verbatim, read out of the running
 *   container (`gunicorn.http.message`). In `[A-Z0-9$-_.]`, `$-_` is a **range**, U+0024 to
 *   U+005F — it is why `A-C`, `A_C`, `A.C` and `A$C` are accepted methods and `get` is not.
 * * Python's `re` matches Unicode digits with `\d`; JavaScript's is ASCII-only. A request
 *   line reading `HTTP/١.١` would therefore be a 400 here and a parsed version in v1. Not
 *   reachable from any client and not worth a bespoke scanner.
 * * `str.split(None, 2)` skips **leading** whitespace, splits on runs of
 *   `\t\n\v\f\r␠`, and leaves the remainder — including its trailing whitespace — in the
 *   third field. {@link splitOnWhitespace} ports that, not `String.prototype.split`.
 */

/**
 * `gunicorn.http.message.METH_RE`, verbatim, anchored the way `re.match` anchors.
 *
 * ⚠️ Do **not** "tidy" `$-_` into `$\-_`: it is a character *range* in Python and in
 * JavaScript alike (U+0024…U+005F), and escaping the hyphen would reduce the class to three
 * literals and turn `A-C`, `A.C` and `A$C` — all of which v1 accepts — into 400s.
 */
const METH_RE = /^[A-Z0-9$-_.]{3,20}/;

/** `gunicorn.http.message.VERSION_RE`, verbatim. Case-sensitive: `http/1.1` is a 400. */
const VERSION_RE = /^HTTP\/(\d+)\.(\d+)/;

/** The characters Python's `str.split(None, …)` treats as whitespace. */
const PYTHON_WHITESPACE = new Set([' ', '\t', '\n', '\v', '\f', '\r']);

/** A parsed request line, or the `mesg` gunicorn's `handle_error` would build for it. */
export type GunicornRequestLine =
  | {
      readonly ok: true;
      /** Upper-cased, as `parse_request_line` does after the regex check. */
      readonly method: string;
      /** `bits[1]`, untouched — the resolver, not this layer, decodes it. */
      readonly uri: string;
      readonly versionMajor: number;
      readonly versionMinor: number;
    }
  | { readonly ok: false; readonly message: string };

/**
 * `bytes.split(None, maxsplit)`.
 *
 * Leading whitespace is skipped, separators are runs rather than single characters, and once
 * `maxsplit` splits have been made the rest of the string is returned as-is — trailing
 * whitespace included. `'FROB   /x   HTTP/1.1 '` therefore yields
 * `['FROB', '/x', 'HTTP/1.1 ']`, which is why a trailing space on the request line is not a
 * 400 in v1.
 */
function splitOnWhitespace(value: string, maxsplit: number): string[] {
  const bits: string[] = [];
  let index = 0;
  while (index < value.length) {
    while (index < value.length && PYTHON_WHITESPACE.has(value[index])) {
      index += 1;
    }
    if (index >= value.length) {
      break;
    }
    if (bits.length === maxsplit) {
      bits.push(value.slice(index));
      break;
    }
    const start = index;
    while (index < value.length && !PYTHON_WHITESPACE.has(value[index])) {
      index += 1;
    }
    bits.push(value.slice(start, index));
  }
  return bits;
}

/**
 * `Request.parse_request_line`, including the three exceptions `Worker.handle_error` turns
 * into a `mesg`.
 *
 * @param line the request line **without** its CRLF, as gunicorn receives it
 */
export function parseGunicornRequestLine(line: string): GunicornRequestLine {
  const bits = splitOnWhitespace(line, 2);
  if (bits.length !== 3) {
    // `"Invalid Request Line '%s'" % str(InvalidRequestLine(line))`
    return { ok: false, message: `Invalid Request Line '${invalidRequestLine(line)}'` };
  }
  if (!METH_RE.test(bits[0])) {
    return { ok: false, message: `Invalid Method '${invalidRequestMethod(bits[0])}'` };
  }
  const version = VERSION_RE.exec(bits[2]);
  if (version === null) {
    return { ok: false, message: `Invalid HTTP Version '${invalidHttpVersion(bits[2])}'` };
  }
  return {
    ok: true,
    method: bits[0].toUpperCase(),
    uri: bits[1],
    versionMajor: Number(version[1]),
    versionMinor: Number(version[2]),
  };
}

/** `InvalidRequestLine.__str__` — `"Invalid HTTP request line: %r"`. */
function invalidRequestLine(line: string): string {
  return `Invalid HTTP request line: ${pythonRepr(line)}`;
}

/** `InvalidRequestMethod.__str__` — `"Invalid HTTP method: %r"`. */
function invalidRequestMethod(method: string): string {
  return `Invalid HTTP method: ${pythonRepr(method)}`;
}

/** `InvalidHTTPVersion.__str__` — `"Invalid HTTP Version: %r"`. */
function invalidHttpVersion(version: string): string {
  return `Invalid HTTP Version: ${pythonRepr(version)}`;
}

/**
 * `gunicorn.util._compat.html_escape`, i.e. CPython's `html.escape(s, quote=True)`.
 *
 * `&` first, or the entities it produces would be escaped again.
 */
function htmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

/**
 * `gunicorn.util.write_error`'s bytes, exactly — `\n` inside the HTML, `\r\n` between the
 * headers, no `Server`, no `Date`, `Content-Length` counted over the HTML, latin-1 on the
 * wire.
 */
export function gunicornWriteError(statusInt: number, reason: string, mesg: string): Buffer {
  const html =
    '<html>\n' +
    '  <head>\n' +
    `    <title>${reason}</title>\n` +
    '  </head>\n' +
    '  <body>\n' +
    `    <h1><p>${reason}</p></h1>\n` +
    `    ${htmlEscape(mesg)}\n` +
    '  </body>\n' +
    '</html>\n';
  const head =
    `HTTP/1.1 ${statusInt} ${reason}\r\n` +
    'Connection: close\r\n' +
    'Content-Type: text/html\r\n' +
    `Content-Length: ${Buffer.byteLength(html, 'latin1')}\r\n` +
    '\r\n';
  return Buffer.from(head + html, 'latin1');
}

/** The 400 `Worker.handle_error` writes for every request-line rejection. */
export function gunicornBadRequest(mesg: string): Buffer {
  return gunicornWriteError(400, 'Bad Request', mesg);
}
