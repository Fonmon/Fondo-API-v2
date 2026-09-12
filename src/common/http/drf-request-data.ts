import type { Request } from 'express';
import { PythonKeyError, PythonTypeError } from '../utils/python-obj';
import { getUploadedFiles, lastUploadedFile, type DjangoUploadedFile } from './django-multipart';
import { getParseState } from './drf-request-parsing.middleware';

/**
 * One entry of DRF's `request.data`, **resolved but not merged** — Phase 8, measurement 2.
 *
 * ## The problem this solves without re-implementing D23
 *
 * DRF's `request.data` is `POST.copy()` then `.update(FILES)` (`rest_framework/request.py`,
 * `_load_data_and_files`), and `MultiValueDict.update` **appends** the file values after the
 * field values. `data[key]` returns the last value, so wherever a key has a file part, the
 * file wins. Plan §4 rule 12c forbids building that merged dict in v2, because reading a
 * file *as a scalar* is the mechanism of **D23**.
 *
 * `FileView.post` (`views/file.py:18-19`) nevertheless observes the merge in two places, and
 * both are measured on the pinned v1 (`~/.fondo-parity-harness/p8/oracle-out2.jsonl`):
 *
 * | request | v1 | a files-only read (rule 12c alone) |
 * |---|---|---|
 * | `file` sent as a plain field | presence check passes → 500 on `.content_type`, after `get_bucket` + `exists` | **400** |
 * | `name` sent as a file part, with or without a `name` field | 500 on `.lower()`, after `get_bucket` | 201 with the field, 400 without |
 * | `type` sent as a file part, with or without a `type` field | 500 on `int()`, before any storage call | 201 / 400 |
 * | a `file` field **and** a `file` part, either order | the part is uploaded → 201 | 201 |
 * | two `file` parts | the **second** is uploaded → 201 | depends on `readUploadedFile` (fixed to last) |
 *
 * So this module answers the two questions v1 asks — *is the key present?* and *which kind of
 * value would `data[key]` return?* — and hands back the value **from its own source**: a file
 * part is only ever a {@link DjangoUploadedFile}, a field is only ever the body's value. No
 * file is stringified, no field is promoted to a file. A caller that finds a file where it
 * needs a scalar fails, exactly as v1 fails; that is the whole observable surface of the
 * merge on this route, and nothing here can write a filename into a column.
 */
export type DrfRequestDataEntry =
  | { readonly source: 'file'; readonly file: DjangoUploadedFile }
  | { readonly source: 'field'; readonly value: unknown };

/**
 * `key in request.data`.
 *
 * `request.data` is a `QueryDict` for form and multipart bodies and whatever `json.loads`
 * returned for JSON, so Python's `in` applies to that value — measured on v1:
 * a JSON list tests membership, a JSON string tests **substring**, and `null`, numbers and
 * booleans raise `TypeError` (`argument of type 'int' is not iterable`).
 */
export function drfRequestDataHas(request: Request, key: string): boolean {
  if (getUploadedFiles(request).some((file) => file.fieldname === key)) {
    return true;
  }
  const body: unknown = request.body;
  if (typeof body === 'string') {
    return body.includes(key);
  }
  if (Array.isArray(body)) {
    // Python `==` between a str and anything but an equal str is False.
    return body.some((element) => element === key);
  }
  if (body !== null && typeof body === 'object') {
    return Object.prototype.hasOwnProperty.call(body, key);
  }
  throw new PythonTypeError(`argument of type '${pythonTypeName(body)}' is not iterable`);
}

/**
 * `request.data[key]`, as {@link DrfRequestDataEntry}.
 *
 * @throws PythonTypeError when the body is a JSON list or string — v1:
 *   `list indices must be integers or slices, not str` / `string indices must be integers`.
 * @throws PythonKeyError when the key is absent from both sources.
 */
export function drfRequestDataGet(request: Request, key: string): DrfRequestDataEntry {
  const body: unknown = request.body;
  if (Array.isArray(body)) {
    throw new PythonTypeError('list indices must be integers or slices, not str');
  }
  if (typeof body === 'string') {
    throw new PythonTypeError('string indices must be integers');
  }
  const file = lastUploadedFile(request, key);
  if (file !== undefined) {
    return { source: 'file', file };
  }
  if (
    body !== null &&
    typeof body === 'object' &&
    Object.prototype.hasOwnProperty.call(body, key)
  ) {
    return { source: 'field', value: (body as Record<string, unknown>)[key] };
  }
  throw new PythonKeyError(key);
}

/**
 * Whether DRF's deferred parse failed **inside `MultiPartParser.__init__`** — the one class of
 * parse failure that a view's own `except Exception` cannot turn into its `Response(500)`.
 *
 * Measured on the pinned v1 under gunicorn (`POST /api/file`, 2026-09-12):
 *
 * | body | v1 |
 * |---|---|
 * | `boundary=` (empty), or a non-ASCII boundary | **gunicorn's 141-byte page** — no `Allow`, no `Vary` |
 * | `text/plain`; malformed JSON; bad base64 in a file part; 1001 multipart fields; 1001 form fields | the view's **zero-byte 500** with `Allow` and `Vary` |
 *
 * The first two raise before the parser has read the stream; the view catches the exception
 * and returns its 500, and Django then re-reads `request.POST` while handling that response,
 * re-raises, and the double fault escapes to gunicorn. The failures in the second row are
 * raised mid-stream, so the re-read finds the stream consumed and returns empty.
 *
 * v2's middleware reports both init-time cases with the same DRF detail prefix, which is what
 * this checks. The measured table is pinned by `test/file.e2e-spec.ts`.
 */
export function isMultipartInitFailure(request: Request): boolean {
  const detail = getParseState(request)?.parseErrorDetail;
  return typeof detail === 'string' && detail.startsWith(INVALID_BOUNDARY_PREFIX);
}

/**
 * Whether the init-time failure was a **non-ASCII** boundary — plan §5 **D22**.
 *
 * D22 decides that v2 answers a non-ASCII boundary with DRF's **400** parse error "on every
 * multipart endpoint in Phases 4–8", naming the Phase 8 file upload. Plan precedence is that
 * §5 decides v2, so `FileView.post` applies it even though, on this route, v1's status is a
 * 500 (the double fault above) rather than the 500-vs-400 pairs D22 recorded elsewhere. The
 * conflict is flagged in `docs/phase-8-deviations.md`; every *other* invalid boundary (empty,
 * trailing space, too long) is not D22's subject and keeps v1's uncaught 500.
 */
export function isNonAsciiBoundaryFailure(request: Request): boolean {
  const detail = getParseState(request)?.parseErrorDetail;
  return (
    typeof detail === 'string' &&
    detail.startsWith(INVALID_BOUNDARY_PREFIX) &&
    Array.from(detail.slice(INVALID_BOUNDARY_PREFIX.length)).some(
      (ch) => (ch.codePointAt(0) as number) > 0x7f,
    )
  );
}

const INVALID_BOUNDARY_PREFIX = 'Multipart form parse error - Invalid boundary in multipart:';

function pythonTypeName(value: unknown): string {
  if (value === null || value === undefined) {
    return 'NoneType';
  }
  if (typeof value === 'boolean') {
    return 'bool';
  }
  if (typeof value === 'bigint') {
    return 'int';
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? 'int' : 'float';
  }
  return typeof value;
}
