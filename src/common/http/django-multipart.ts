import { PythonKeyError } from '../utils/python-obj';
import { parseHeader, stripAsciiWhitespace, type ParsedHeader } from './django-parse-header';

/**
 * `django.http.multipartparser.MultiPartParser`, ported from the installed
 * `Django==2.2.27` — parity finding **F8**.
 *
 * ## Why v2 needed its own parser instead of multer
 *
 * Round 2 found malformed `multipart/form-data` crossing the 400/500 line **in both
 * directions**, and the sharp case was `boundary=` (empty), which v1 answers with a
 * diagnostic 400 and v2 answered with a bare 500. Chasing the individual symptoms was the
 * wrong shape of fix: busboy (under multer) is a *strict* RFC parser that aborts on anything
 * malformed, and Django's is a *scavenging* one that raises in exactly three places and
 * otherwise salvages whatever it can. Measured on the live v1 with `POST /api-token-auth`
 * (multipart-capable and zero-write, so the parse result shows up in the serializer's
 * complaint):
 *
 * | body / `Content-Type` | v1 | v2 with multer |
 * |---|---|---|
 * | `multipart/form-data` (no `boundary` at all) | `request.data` **empty** → `400 {"username":[…],"password":[…]}` | `400 Multipart form parse error - Multipart: Boundary not found` |
 * | `boundary=` (empty) | `400 Multipart form parse error - Invalid boundary in multipart: ` | **500** |
 * | `boundary=zzz`, body not multipart | data empty → the serializer 400 | `400 … Unexpected end of form` |
 * | `boundary=zzz`, a part truncated mid-stream | the field **is** read → `400 {"password":[…]}` | `400 … Unexpected end of form` |
 * | `boundary=zzz`, part has no `Content-Disposition` | part skipped, data empty | `400 … Malformed part header` |
 * | `boundary=zzz`, body uses a *different* boundary | the whole body becomes one part and its header is read → `400 {"password":[…]}` | `400 … Unexpected end of form` |
 * | `boundary="zzz "` (trailing space) | `400 … Invalid boundary in multipart: zzz ` | `400 … Unexpected end of form` |
 * | `boundary` of 202 characters | `400 … Invalid boundary in multipart: aaa…` | `400 … Unexpected end of form` |
 * | `boundary="a<TAB>b"` | `400 … Invalid boundary in multipart: a\tb` | the serializer 400 |
 *
 * On `PATCH /api/user` — whose handler does `obj['file']` — "data empty" surfaces as a
 * `MultiValueDictKeyError`, i.e. an **uncaught 500**, which is why round 2 saw 500s where
 * this table shows serializer 400s. Same parser, different handler.
 *
 * ## The missing `boundary` is an `AttributeError`, and DRF swallows it
 *
 * ```python
 * boundary = opts.get('boundary')
 * if not boundary or not cgi.valid_boundary(boundary):
 *     raise MultiPartParserError('Invalid boundary in multipart: %s' % boundary.decode())
 * ```
 *
 * With no `boundary` parameter, `boundary` is `None` and `None.decode()` raises
 * `AttributeError` — **not** `MultiPartParserError`, so DRF does not turn it into a 400. It
 * escapes through `Request._parse`, whose `except Exception:` first assigns
 * `self._data = QueryDict()` / `self._full_data = self._data` and *then* re-raises. Because
 * `Request.data` is a **property**, an `AttributeError` raised inside it sends Python to
 * `Request.__getattr__`, which calls `self.__getattribute__('data')` — re-entering the
 * property, which this time finds `_full_data` already set and returns the **empty
 * QueryDict**. The exception disappears and the view sees an empty body.
 *
 * That is why `NO_BOUNDARY` is modelled as an outcome rather than an error: it is not
 * "Django failed", it is "the view receives empty data", and the status the client sees is
 * whatever the handler does with an empty body. Verified live on both endpoints.
 *
 * ## Three, and only three, ways this raises `MultiPartParserError` (→ DRF 400)
 *
 *  1. `Invalid Content-Type: <ct>` — unreachable here, DRF only selects this parser for a
 *     `multipart/*` content type;
 *  2. `Invalid boundary in multipart: <boundary>` — empty, or failing `cgi.valid_boundary`;
 *  3. `Could not decode base64 data.` — a part with `Content-Transfer-Encoding: base64`
 *     whose *file* chunk is not decodable (the FIELD branch swallows `binascii.Error` and
 *     keeps the raw bytes).
 *
 * Everything else — a missing final boundary, a part with no header, a header that is not a
 * header, a body that is not multipart at all — is salvaged silently.
 *
 * ## Registered residuals
 *
 *  * `SuspiciousMultipartForm` ("the multipart parser got stuck") is Django's guard against a
 *    `LazyStream.unget` loop. This port addresses the body as a buffer and has no unget, so
 *    the loop it detects cannot occur; the guard is therefore not portable and not ported.
 *  * `sanitize_file_name` calls `html.unescape`, which is CPython's full HTML5 entity table.
 *    {@link sanitizeFileName} covers the numeric references and the five basic named ones.
 *    No v1 handler reads an uploaded file's *name* (`bulk_update_users` reads the content,
 *    `FileView.post` reads a separate `name` **field**), so this is unobservable today.
 *  * `chunk_size` (64 KiB) shapes `BoundaryIter`'s rollback, not its result: the concatenated
 *    output for any body is the same whether it arrives in one chunk or twenty. Verified by
 *    differential test against v1 on bodies either side of the chunk size.
 */

/** `MultiPartParserError` — the only exception DRF converts into a `400 ParseError`. */
export class MultiPartParserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MultiPartParserError';
  }
}

/** `RequestDataTooBig` / `TooManyFieldsSent` — `SuspiciousOperation`, which Django 400s. */
export class DjangoSuspiciousOperation extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SuspiciousOperation';
  }
}

/** One `FILE` part, in the shape `multer`'s `.any()` produced so consumers are unchanged. */
export interface DjangoUploadedFile {
  /** The `name` parameter of the part's `Content-Disposition`. */
  readonly fieldname: string;
  /** The sanitised `filename` parameter. */
  readonly originalname: string;
  /** The part's `Content-Type`, or `''`. */
  readonly mimetype: string;
  /** The part body, verbatim. */
  readonly buffer: Buffer;
}

/** `(MultiValueDict(POST), MultiValueDict(FILES))`, plus the no-boundary outcome. */
export interface DjangoMultipartResult {
  /**
   * `False` when the `boundary` parameter was absent — DRF's `Request.data` ends up an
   * **empty QueryDict** and the view is none the wiser. See the module docs.
   */
  readonly parsed: boolean;
  /** `QueryDict` — every value kept, in order, per field name. */
  readonly fields: ReadonlyMap<string, readonly string[]>;
  readonly files: readonly DjangoUploadedFile[];
}

/** `settings.DATA_UPLOAD_MAX_MEMORY_SIZE` — Django's default, and v1 does not override it. */
const DATA_UPLOAD_MAX_MEMORY_SIZE = 2.5 * 1024 * 1024;
/** `settings.DATA_UPLOAD_MAX_NUMBER_FIELDS` — Django's default. */
const DATA_UPLOAD_MAX_NUMBER_FIELDS = 1000;
/** `parse_boundary_stream(sub_stream, 1024)` — a part header must fit in the first 1 KiB. */
const MAX_HEADER_SIZE = 1024;

/**
 * `MultiPartParser(META, input_data, upload_handlers, encoding).parse()`.
 *
 * @param contentType the raw `Content-Type` request header.
 * @param body the request body, already read. Django streams it; the observable result is
 *   identical (see the residual on `chunk_size`), and multer's `memoryStorage` — what this
 *   replaces — buffered it in full too, so the memory profile is unchanged.
 * @param encoding `settings.DEFAULT_CHARSET`, `'utf-8'` in v1.
 * @throws MultiPartParserError which DRF renders as
 *   `400 {"detail": "Multipart form parse error - <message>"}`.
 * @throws DjangoSuspiciousOperation which Django renders as its own 400 page.
 */
export function parseDjangoMultipart(
  contentType: string,
  body: Buffer,
  encoding = 'utf-8',
): DjangoMultipartResult {
  if (!contentType.startsWith('multipart/')) {
    throw new MultiPartParserError(`Invalid Content-Type: ${contentType}`);
  }

  const { params } = parseHeader(Buffer.from(contentType, 'latin1'));
  const boundary = params.get('boundary');
  if (boundary === undefined) {
    // `None.decode()` -> AttributeError -> DRF hands the view an empty QueryDict.
    return EMPTY_RESULT;
  }
  if (boundary.length === 0 || !validBoundary(boundary)) {
    throw new MultiPartParserError(`Invalid boundary in multipart: ${boundary.toString('utf8')}`);
  }

  // `if self._content_length == 0: return QueryDict(), MultiValueDict()`
  if (body.length === 0) {
    return { parsed: true, fields: new Map(), files: [] };
  }

  const fields = new Map<string, string[]>();
  const files: DjangoUploadedFile[] = [];
  let numBytesRead = 0;
  let numPostKeys = 0;

  for (const part of splitOnBoundary(body, boundary)) {
    if (part.type === 'raw') {
      // `meta_data['content-disposition']` -> KeyError -> `continue`.
      continue;
    }

    const disposition = part.meta.get('content-disposition')?.params;
    const rawFieldName = disposition?.get('name');
    if (disposition === undefined || rawFieldName === undefined) {
      continue;
    }
    const fieldName = forceText(stripAsciiWhitespace(rawFieldName), encoding);
    const transferEncoding = part.meta.get('content-transfer-encoding')?.value.trim();

    if (part.type === 'field') {
      numPostKeys += 1;
      if (numPostKeys > DATA_UPLOAD_MAX_NUMBER_FIELDS) {
        throw new DjangoSuspiciousOperation(
          'The number of GET/POST parameters exceeded settings.DATA_UPLOAD_MAX_NUMBER_FIELDS.',
        );
      }

      const readSize = DATA_UPLOAD_MAX_MEMORY_SIZE - numBytesRead;
      const raw = part.payload.subarray(0, Math.max(0, readSize));
      numBytesRead += raw.length;

      let data = raw;
      if (transferEncoding === 'base64') {
        // `except binascii.Error: data = raw_data` — an undecodable *field* keeps its bytes.
        const decoded = decodeBase64Strict(raw);
        data = decoded ?? raw;
      }

      // "Add two here to make the check consistent with the x-www-form-urlencoded check".
      numBytesRead += Buffer.byteLength(fieldName, 'utf8') + 2;
      if (numBytesRead > DATA_UPLOAD_MAX_MEMORY_SIZE) {
        throw new DjangoSuspiciousOperation(
          'Request body exceeded settings.DATA_UPLOAD_MAX_MEMORY_SIZE.',
        );
      }

      appendList(fields, fieldName, forceText(data, encoding));
      continue;
    }

    const rawFileName = disposition.get('filename');
    if (rawFileName === undefined || rawFileName.length === 0) {
      continue;
    }
    const fileName = sanitizeFileName(forceText(rawFileName, encoding));
    if (fileName === null) {
      continue;
    }

    let content = part.payload;
    if (transferEncoding === 'base64') {
      const decoded = decodeBase64Strict(content);
      if (decoded === null) {
        // The FILE branch, unlike the FIELD branch, treats this as fatal.
        throw new MultiPartParserError('Could not decode base64 data.');
      }
      content = decoded;
    }

    files.push({
      fieldname: fieldName,
      originalname: fileName,
      mimetype: (part.meta.get('content-type')?.value ?? '').trim(),
      buffer: content,
    });
  }

  return { parsed: true, fields, files };
}

const EMPTY_RESULT: DjangoMultipartResult = Object.freeze({
  parsed: false,
  fields: new Map<string, readonly string[]>(),
  files: [] as readonly DjangoUploadedFile[],
});

/**
 * `cgi.valid_boundary`: `re.match(b"^[ -~]{0,200}[!-~]$", s)`.
 *
 * Three details that are easy to get wrong and all observable (each verified live):
 *  * the maximum length is **201** bytes, not 200 — 0-200 for the first class plus one;
 *  * the last byte may not be a space, so `boundary="zzz "` is *invalid* (v1: 400);
 *  * `re.match`'s `$` also matches immediately before a **trailing newline**, so a boundary
 *    ending in exactly one `\n` is accepted.
 */
export function validBoundary(value: Buffer): boolean {
  const candidate =
    value.length > 0 && value[value.length - 1] === 0x0a ? value.subarray(0, -1) : value;
  if (candidate.length < 1 || candidate.length > 201) {
    return false;
  }
  for (let index = 0; index < candidate.length - 1; index += 1) {
    const byte = candidate[index] ?? -1;
    if (byte < 0x20 || byte > 0x7e) {
      return false;
    }
  }
  const last = candidate[candidate.length - 1] ?? -1;
  return last >= 0x21 && last <= 0x7e;
}

/** One yield of `Parser.__iter__`, i.e. one `parse_boundary_stream` result. */
type BoundaryPart =
  | { readonly type: 'raw' }
  | {
      readonly type: 'field' | 'file';
      readonly meta: ReadonlyMap<string, { value: string; params: ReadonlyMap<string, Buffer> }>;
      readonly payload: Buffer;
    };

/**
 * `Parser.__iter__` over `InterBoundaryIter` / `BoundaryIter`, with the stream machinery
 * collapsed into buffer arithmetic.
 *
 * `BoundaryIter._find_boundary` is reproduced exactly, including its backing up over at most
 * one `\n` and then at most one `\r`, and its `max(0, end - 1)` indexing — which is why a
 * body that *starts* with the separator yields an empty first part rather than an underflow.
 * A body containing no separator at all yields **one** part covering the whole body, which is
 * the behaviour that lets v1 read a field out of a body whose boundary does not match the
 * header's.
 */
function* splitOnBoundary(body: Buffer, boundary: Buffer): Generator<BoundaryPart> {
  const separator = Buffer.concat([DASH_DASH, boundary]);
  let position = 0;

  while (position < body.length) {
    const chunk = body.subarray(position);
    const index = chunk.indexOf(separator);

    if (index < 0) {
      yield parseBoundaryStream(chunk);
      return;
    }

    let end = index;
    if (chunk[Math.max(0, end - 1)] === 0x0a) {
      end -= 1;
    }
    if (chunk[Math.max(0, end - 1)] === 0x0d) {
      end -= 1;
    }

    yield parseBoundaryStream(chunk.subarray(0, end));
    position += index + separator.length;
  }
}

/**
 * ```python
 * def parse_boundary_stream(stream, max_header_size):
 *     chunk = stream.read(max_header_size)
 *     header_end = chunk.find(b'\r\n\r\n')
 *     if header_end == -1:
 *         stream.unget(chunk)
 *         return (RAW, {}, stream)
 *     header = chunk[:header_end]
 *     stream.unget(chunk[header_end + 4:])
 *     TYPE = RAW
 *     outdict = {}
 *     for line in header.split(b'\r\n'):
 *         try:
 *             name, (value, params) = _parse_header(line)
 *         except ValueError:
 *             continue
 *         if name == 'content-disposition':
 *             TYPE = FIELD
 *             if params.get('filename'):
 *                 TYPE = FILE
 *         outdict[name] = value, params
 *     if TYPE == RAW:
 *         stream.unget(chunk)
 *     return (TYPE, outdict, stream)
 * ```
 *
 * The `max_header_size` read is load-bearing: a part whose `\r\n\r\n` is more than 1 KiB in
 * is `RAW`, i.e. silently dropped, however well-formed the rest of it is.
 */
function parseBoundaryStream(part: Buffer): BoundaryPart {
  const chunk = part.subarray(0, MAX_HEADER_SIZE);
  const headerEnd = chunk.indexOf(CRLFCRLF);
  if (headerEnd === -1) {
    return RAW_PART;
  }

  const header = chunk.subarray(0, headerEnd);
  const payload = part.subarray(headerEnd + 4);

  let type: 'field' | 'file' | null = null;
  const meta = new Map<string, { value: string; params: ReadonlyMap<string, Buffer> }>();

  for (const line of splitCrLf(header)) {
    let parsed: ParsedHeader;
    try {
      parsed = parseHeader(line);
    } catch {
      continue;
    }
    // `_parse_header`: `name, value = main_value_pair.split(':', 1)`, else `ValueError`.
    const colon = parsed.key.indexOf(':');
    if (colon < 0) {
      continue;
    }
    const name = parsed.key.slice(0, colon);
    const value = parsed.key.slice(colon + 1);

    if (name === 'content-disposition') {
      type = 'field';
      const filename = parsed.params.get('filename');
      if (filename !== undefined && filename.length > 0) {
        type = 'file';
      }
    }
    meta.set(name, { value, params: parsed.params });
  }

  if (type === null) {
    return RAW_PART;
  }
  return { type, meta, payload };
}

const RAW_PART: BoundaryPart = Object.freeze({ type: 'raw' as const });

function splitCrLf(value: Buffer): Buffer[] {
  const lines: Buffer[] = [];
  let start = 0;
  for (;;) {
    const index = value.indexOf(CRLF, start);
    if (index < 0) {
      lines.push(value.subarray(start));
      return lines;
    }
    lines.push(value.subarray(start, index));
    start = index + 2;
  }
}

/**
 * `MultiPartParser.sanitize_file_name`. `html.unescape` is reduced to numeric references and
 * the five basic named ones — see the module docs for why that is unobservable here.
 */
export function sanitizeFileName(fileName: string): string | null {
  let name = htmlUnescape(fileName);
  name = name.split('/').pop() ?? '';
  name = name.split('\\').pop() ?? '';
  if (name === '' || name === '.' || name === '..') {
    return null;
  }
  return name;
}

function htmlUnescape(value: string): string {
  return value
    .replace(/&#x([0-9a-fA-F]+);?/g, (_all, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);?/g, (_all, digits: string) =>
      String.fromCodePoint(Number.parseInt(digits, 10)),
    )
    .replace(/&lt;?/g, '<')
    .replace(/&gt;?/g, '>')
    .replace(/&quot;?/g, '"')
    .replace(/&#39;?/g, "'")
    .replace(/&amp;?/g, '&');
}

/** `base64.b64decode(raw)` — strict enough to raise `binascii.Error` on bad padding. */
function decodeBase64Strict(value: Buffer): Buffer | null {
  const stripped = value.toString('latin1').replace(/\s+/g, '');
  if (stripped.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(stripped)) {
    return null;
  }
  return Buffer.from(stripped, 'base64');
}

/** `force_text(data, encoding, errors='replace')` — `DEFAULT_CHARSET` is `utf-8` in v1. */
function forceText(value: Buffer, encoding: string): string {
  return new TextDecoder(encoding, { fatal: false }).decode(value);
}

/** `MultiValueDict.appendlist`. */
function appendList(target: Map<string, string[]>, key: string, value: string): void {
  const existing = target.get(key);
  if (existing === undefined) {
    target.set(key, [value]);
    return;
  }
  existing.push(value);
}

const DASH_DASH = Buffer.from('--');
const CRLF = Buffer.from('\r\n');
const CRLFCRLF = Buffer.from('\r\n\r\n');

/**
 * Where the `FILE` parts live between {@link parseDjangoMultipart} and the controller.
 *
 * A symbol on the request rather than `request.files`, which was multer's global
 * `Express.Request` augmentation: with multer no longer in the request path, relying on a
 * type another package declares would have been a phantom dependency of exactly the kind
 * condition **C12** was raised about.
 */
const UPLOADED_FILES = Symbol('djangoUploadedFiles');

/** Publishes the parsed `FILES` on the request. */
export function setUploadedFiles(request: object, files: readonly DjangoUploadedFile[]): void {
  (request as Record<symbol, unknown>)[UPLOADED_FILES] = files;
}

/** `request.FILES`, or an empty list on a request that carried no multipart body. */
export function getUploadedFiles(request: object): readonly DjangoUploadedFile[] {
  const files = (request as Record<symbol, unknown>)[UPLOADED_FILES];
  return Array.isArray(files) ? (files as readonly DjangoUploadedFile[]) : [];
}

/**
 * `request.data['<field>']` on a multipart upload — i.e. Django's `request.FILES[field]`.
 *
 * **This is the standing pattern for every file part in every phase** (plan §4 rule 12c,
 * review C36). DRF's `request.data` is the `QueryDict` *merged with* `FILES`, and v1's
 * `UserView.patch` (P3), `LoanView.patch` (P4) and `FileView.post` (P8) all read `obj['file']`
 * only because of that merge. v2 does **not** implement the merge — it is the exact mechanism
 * of deviation **D23** — so a handler must reach for the file explicitly, here.
 *
 * A missing part is v1's `KeyError`: a **500**, not a 400. That is not a rough edge to be
 * smoothed over in a later phase; it is the measured status for `PATCH /api/user` with a JSON
 * body, with a form body, and with a multipart body carrying no `file` part.
 *
 * ⚠️ **Two parts with the same name: the LAST one**, because `MultiValueDict.__getitem__`
 * returns `list[-1]`. Measured on the pinned v1 on 2026-09-12 (`POST /api/file` with parts
 * `FIRST` then `SECOND`: `SECOND` was uploaded). Through Phase 7 this function took the
 * *first*; the fix is registered in `docs/phase-8-deviations.md` because it changes the
 * Phase 3 and Phase 4 bulk uploads for that request shape too.
 *
 * ⚠️ Do **not** pair this with a narrowed parser list. `@parser_classes((MultiPartParser,))`
 * on an `APIView` *method* is a no-op in v1 (plan §4 rule 12b) — all three handlers accept the
 * default parser list, JSON included, and then 500 here.
 */
export function readUploadedFile(request: object, field: string): Buffer {
  const match = lastUploadedFile(request, field);
  if (match === undefined) {
    throw new PythonKeyError(field);
  }
  return match.buffer;
}

/**
 * `request.FILES.get(field)` — the last part named `field`, or `undefined`. See
 * {@link readUploadedFile} for why it is the last.
 */
export function lastUploadedFile(request: object, field: string): DjangoUploadedFile | undefined {
  const files = getUploadedFiles(request);
  for (let index = files.length - 1; index >= 0; index -= 1) {
    if (files[index].fieldname === field) {
      return files[index];
    }
  }
  return undefined;
}
