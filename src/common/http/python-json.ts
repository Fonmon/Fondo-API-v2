/**
 * Emulation of CPython's `json.loads` **error messages**, so that a malformed request body
 * produces the byte-identical DRF response v1 produces.
 *
 * v1 side: `rest_framework/parsers.py::JSONParser.parse` does
 *
 * ```python
 * try:
 *     return json.load(decoded_stream)
 * except ValueError as exc:
 *     raise ParseError('JSON parse error - %s' % str(exc))
 * ```
 *
 * so the *text of a CPython exception* is part of v1's HTTP contract:
 *
 * ```json
 * {"detail": "JSON parse error - Expecting value: line 1 column 1 (char 0)"}
 * ```
 *
 * Node's own message for the same body is
 * `Unexpected token 'n', "not json" is not valid JSON` — a different string, so the response
 * cannot be produced by re-wrapping it. This module reproduces CPython's scanner closely
 * enough to emit the same message and the same character offset.
 *
 * ## Which CPython?
 *
 * The **C** scanner (`_json`), which is what `json.loads` uses by default and therefore what
 * v1 runs. Its messages and offsets differ from the pure-Python fallback in two places
 * (`Invalid control character at` and `Invalid \escape` point *at* the offending character
 * rather than past it, and the C version omits the `repr()` of the character). Every message
 * and offset below was captured from `python:3.9-slim` — see `python-json.spec.ts`, whose
 * fixture is a differential capture, not a transcription.
 *
 * ## Known limits (documented, not silently wrong)
 *
 * Offsets are counted in **UTF-16 code units** because that is what a JS string index is,
 * while CPython counts code points. A malformed body containing an astral character
 * (emoji, some CJK extensions) *before* the error position will report an offset larger than
 * CPython's. No v1 client sends one, and the status code and message text are unaffected.
 */

const WHITESPACE = /[ \t\n\r]*/y;
// CPython's `STRINGCHUNK`: content, then the first `"`, `\` or control character. The
// control-character range is the point of the pattern — it is how `Invalid control
// character at` is detected — so the lint rule is disabled deliberately here.
// eslint-disable-next-line no-control-regex
const STRING_CHUNK = /([\s\S]*?)(["\\\u0000-\u001f])/y;
const NUMBER = /(-?(?:0|[1-9]\d*))(\.\d+)?([eE][-+]?\d+)?/y;

const BACKSLASH_ESCAPES = new Set(['"', '\\', '/', 'b', 'f', 'n', 'r', 't']);

/** The `msg` half of a `json.JSONDecodeError`, before position formatting. */
class PythonJsonDecodeError extends Error {
  constructor(
    readonly msg: string,
    readonly pos: number,
  ) {
    super(msg);
    this.name = 'PythonJsonDecodeError';
  }
}

/** Skips `[ \t\n\r]*` from `index`, returning the first non-whitespace index. */
function skipWhitespace(text: string, index: number): number {
  WHITESPACE.lastIndex = Math.min(index, text.length);
  const match = WHITESPACE.exec(text);
  return match === null ? index : WHITESPACE.lastIndex;
}

/**
 * `json.decoder.JSONDecodeError.__init__`:
 *
 * ```python
 * lineno = doc.count('\n', 0, pos) + 1
 * colno = pos - doc.rfind('\n', 0, pos)
 * errmsg = '%s: line %d column %d (char %d)' % (msg, lineno, colno, pos)
 * ```
 */
export function formatPythonJsonError(msg: string, pos: number, text: string): string {
  const before = text.slice(0, pos);
  const lineno = before.split('\n').length;
  const colno = pos - before.lastIndexOf('\n');
  return `${msg}: line ${lineno} column ${colno} (char ${pos})`;
}

/**
 * `\uXXXX` — returns the code point, or throws `Invalid \uXXXX escape` at the index of the
 * `u`, which is where the C scanner points.
 *
 * ⚠️ The C scanner also rejects an escape whose four digits are the **last** characters of
 * the document, before it ever looks at them: it needs at least one character after the
 * escape (the string cannot be closed otherwise). Captured, not guessed —
 * `json.loads('"\\u0041')` is `Invalid \uXXXX escape` while `json.loads('"\\u0041x')` is
 * `Unterminated string starting at`.
 */
function decodeUnicodeEscape(text: string, uIndex: number): number {
  if (uIndex + 5 >= text.length) {
    throw new PythonJsonDecodeError('Invalid \\uXXXX escape', uIndex);
  }
  const escape = text.slice(uIndex + 1, uIndex + 5);
  if (/^[0-9a-fA-F]{4}$/.test(escape)) {
    return Number.parseInt(escape, 16);
  }
  throw new PythonJsonDecodeError('Invalid \\uXXXX escape', uIndex);
}

/**
 * `scanstring(s, end)` where `end` is the index **after** the opening quote.
 * Returns the index after the closing quote.
 */
function scanString(text: string, start: number): number {
  const begin = start - 1;
  let index = start;

  for (;;) {
    STRING_CHUNK.lastIndex = index;
    const chunk = STRING_CHUNK.exec(text);
    if (chunk === null) {
      throw new PythonJsonDecodeError('Unterminated string starting at', begin);
    }
    const terminator = chunk[2];
    const terminatorIndex = STRING_CHUNK.lastIndex - 1;
    index = STRING_CHUNK.lastIndex;

    if (terminator === '"') {
      return index;
    }
    if (terminator !== '\\') {
      // C scanner: points at the control character itself.
      throw new PythonJsonDecodeError('Invalid control character at', terminatorIndex);
    }

    const escape = text[index];
    if (escape === undefined) {
      throw new PythonJsonDecodeError('Unterminated string starting at', begin);
    }
    if (escape !== 'u') {
      if (!BACKSLASH_ESCAPES.has(escape)) {
        // C scanner: points at the backslash, and omits the repr of the escape character.
        throw new PythonJsonDecodeError('Invalid \\escape', terminatorIndex);
      }
      index += 1;
      continue;
    }

    const first = decodeUnicodeEscape(text, index);
    index += 5;
    if (first >= 0xd800 && first <= 0xdbff && text.slice(index, index + 2) === '\\u') {
      const second = decodeUnicodeEscape(text, index + 1);
      if (second >= 0xdc00 && second <= 0xdfff) {
        index += 6;
      }
    }
  }
}

/** `JSONObject` — `start` is the index after `{`. Returns the index after `}`. */
function scanObject(text: string, start: number): number {
  let index = start;
  let nextChar = text[index];

  if (nextChar !== '"') {
    if (nextChar !== undefined && ' \t\n\r'.includes(nextChar)) {
      index = skipWhitespace(text, index);
      nextChar = text[index];
    }
    if (nextChar === '}') {
      return index + 1;
    }
    if (nextChar !== '"') {
      throw new PythonJsonDecodeError('Expecting property name enclosed in double quotes', index);
    }
  }
  index += 1;

  for (;;) {
    index = scanString(text, index);

    if (text[index] !== ':') {
      index = skipWhitespace(text, index);
      if (text[index] !== ':') {
        throw new PythonJsonDecodeError("Expecting ':' delimiter", index);
      }
    }
    index += 1;
    index = skipWhitespace(text, index);

    index = scanValue(text, index);

    let separator = text[index];
    if (separator !== undefined && ' \t\n\r'.includes(separator)) {
      index = skipWhitespace(text, index + 1);
      separator = text[index];
    }
    index += 1;

    if (separator === '}') {
      return index;
    }
    if (separator !== ',') {
      throw new PythonJsonDecodeError("Expecting ',' delimiter", index - 1);
    }

    index = skipWhitespace(text, index);
    const quote = text[index];
    index += 1;
    if (quote !== '"') {
      throw new PythonJsonDecodeError(
        'Expecting property name enclosed in double quotes',
        index - 1,
      );
    }
  }
}

/** `JSONArray` — `start` is the index after `[`. Returns the index after `]`. */
function scanArray(text: string, start: number): number {
  let index = start;
  let nextChar = text[index];
  if (nextChar !== undefined && ' \t\n\r'.includes(nextChar)) {
    index = skipWhitespace(text, index + 1);
    nextChar = text[index];
  }
  if (nextChar === ']') {
    return index + 1;
  }

  for (;;) {
    index = scanValue(text, index);

    let separator = text[index];
    if (separator !== undefined && ' \t\n\r'.includes(separator)) {
      index = skipWhitespace(text, index + 1);
      separator = text[index];
    }
    index += 1;

    if (separator === ']') {
      return index;
    }
    if (separator !== ',') {
      throw new PythonJsonDecodeError("Expecting ',' delimiter", index - 1);
    }
    index = skipWhitespace(text, index);
  }
}

/** `scan_once` — returns the index after the value, or throws `Expecting value` at `index`. */
function scanValue(text: string, index: number): number {
  const char = text[index];
  if (char === undefined) {
    throw new PythonJsonDecodeError('Expecting value', index);
  }
  if (char === '"') {
    return scanString(text, index + 1);
  }
  if (char === '{') {
    return scanObject(text, index + 1);
  }
  if (char === '[') {
    return scanArray(text, index + 1);
  }
  if (text.startsWith('null', index)) {
    return index + 4;
  }
  if (text.startsWith('true', index)) {
    return index + 4;
  }
  if (text.startsWith('false', index)) {
    return index + 5;
  }

  NUMBER.lastIndex = index;
  const number = NUMBER.exec(text);
  if (number !== null && number[0].length > 0) {
    return NUMBER.lastIndex;
  }

  // CPython's decoder accepts these three non-standard literals by default.
  if (text.startsWith('NaN', index)) {
    return index + 3;
  }
  if (text.startsWith('Infinity', index)) {
    return index + 8;
  }
  if (text.startsWith('-Infinity', index)) {
    return index + 9;
  }

  throw new PythonJsonDecodeError('Expecting value', index);
}

/**
 * The message `str(exc)` would produce for `json.loads(text)`, or `null` when CPython would
 * have parsed `text` successfully.
 *
 * Only the *shape* of the document is scanned; no value is built, because the caller
 * (`DrfRequestParsingMiddleware`) already has `JSON.parse`'s result for the valid case and
 * only needs this module when it has to explain a failure.
 */
export function pythonJsonLoadsError(text: string): string | null {
  // `json.loads` rejects a BOM before the scanner ever runs.
  if (text.startsWith('\ufeff')) {
    return formatPythonJsonError('Unexpected UTF-8 BOM (decode using utf-8-sig)', 0, text);
  }

  try {
    const start = skipWhitespace(text, 0);
    let end = scanValue(text, start);
    end = skipWhitespace(text, end);
    if (end !== text.length) {
      throw new PythonJsonDecodeError('Extra data', end);
    }
    return null;
  } catch (error) {
    if (error instanceof PythonJsonDecodeError) {
      return formatPythonJsonError(error.msg, error.pos, text);
    }
    /* istanbul ignore next -- the scanner throws nothing else */
    throw error;
  }
}

/**
 * DRF's `ParseError` detail for a malformed JSON body:
 * `'JSON parse error - %s' % str(exc)` (`rest_framework/parsers.py:66`).
 */
export function drfJsonParseErrorDetail(text: string): string {
  const message =
    pythonJsonLoadsError(text) ??
    /* istanbul ignore next -- only called after JSON.parse already failed */
    'Expecting value: line 1 column 1 (char 0)';
  return `JSON parse error - ${message}`;
}
