import { Injectable, type NestMiddleware } from '@nestjs/common';
import express, { type NextFunction, type Request, type Response } from 'express';
import {
  DjangoSuspiciousOperation,
  MultiPartParserError,
  parseDjangoMultipart,
  setUploadedFiles,
} from './django-multipart';
import {
  DRF_PARSER_MEDIA_TYPES,
  mediaTypeMatches,
  type DrfParserMediaType,
} from './drf-media-type';
import { drfJsonParseErrorDetail } from './python-json';

/**
 * Reproduces `rest_framework.request.Request._parse` on the Express side — reviewer finding
 * S3, plan §5 **D18**.
 *
 * ## What was wrong
 *
 * | Request to `POST /api-token-auth` | v1 (DRF 3.11.2) | v2 before this |
 * |---|---|---|
 * | `multipart/form-data` + valid credentials | **200** + token | 400 "field is required" |
 * | `text/plain` + a body | **415** `Unsupported media type "text/plain" in request.` | 400 |
 * | malformed JSON | **400** `{"detail": "JSON parse error - Expecting value: line 1 column 1 (char 0)"}` | 400 with Node's message |
 *
 * The multipart row is the load-bearing one: `UserView.patch` (`views/user.py:36`) and
 * `LoanView.patch` (`views/loan.py:49`) are the **bulk TSV upload** endpoints and both declare
 * `@parser_classes((MultiPartParser,))`, so without multipart support Phases 3 and 4 cannot
 * work at all.
 *
 * ## Design: parse permissively here, decide in the interceptor
 *
 * DRF parses **lazily** — `request.data` is first touched inside the view handler, i.e. *after*
 * `APIView.initial()` has authenticated and checked permissions. So a request with both a bad
 * token and a bad body 401s in v1; it must not 400.
 *
 * Nest's built-in body parser is the opposite: it throws from middleware, before any guard.
 * This middleware therefore replaces it (`bodyParser: false`, see `src/bootstrap.ts`) and
 * **never fails a request**. It records what it found on the request object and
 * {@link DrfParserInterceptor} — which runs after the guards — raises the 415 or the 400.
 *
 * ## Scope
 *
 * Only `POST`, `PUT` and `PATCH` are parsed, because those are the only methods whose v1
 * handlers read `request.data` (verified across all of `fondo_api/views/`). A `GET` with a
 * strange `Content-Type` must **not** 415, and in v1 it does not: nothing touches `request.data`
 * so `_parse` never runs.
 *
 * A body of zero length is also left alone: `Request._load_stream` sets `self._stream = None`
 * when `CONTENT_LENGTH` is 0, and `_parse` then returns an empty `QueryDict` **without**
 * negotiating — so an empty `text/plain` POST is a 400 "field required" in v1, not a 415
 * (verified against the pinned stack).
 */
@Injectable()
export class DrfRequestParsingMiddleware implements NestMiddleware {
  /**
   * `DATA_UPLOAD_MAX_MEMORY_SIZE` — Django's default, 2.5 MB, applied to non-file bodies.
   * Express's own default is 100 kB, which would have turned Phase 3/4's bulk uploads into a
   * 500 (`PayloadTooLargeError` is not an `HttpException`).
   */
  private static readonly DATA_UPLOAD_MAX_MEMORY_SIZE = 2.5 * 1024 * 1024;

  /**
   * ⚠️ `strict: false` is the parity setting, not a relaxation — reviewer finding **R4**,
   * condition **C11**. body-parser defaults to `strict: true`, which rejects a top-level
   * scalar (`5`, `null`, `true`) with a `SyntaxError` that **CPython never raises**:
   * `json.loads('5')` returns the int, DRF hands it to the serializer, and v1 answers
   * `400 {"non_field_errors": ["Invalid data. Expected a dictionary, but got int."]}`.
   * With strict mode on, v2 answered a fabricated `JSON parse error - Expecting value: …`
   * instead. Off, the scalar reaches the DTO layer and the DTO produces DRF's message
   * (`auth-token.serializer.ts` already does; Phase 3's DTOs must too).
   *
   * One residual remains, registered in `docs/phase-1-drf-auth-bodies.md`: CPython's
   * `json.loads` accepts `NaN`, `Infinity` and `-Infinity`, and `JSON.parse` does not, so
   * those three bodies are a 400 parse error in v2 and a `got float` serializer error in v1.
   * No client sends them.
   */
  private readonly json = express.json({
    strict: false,
    limit: DrfRequestParsingMiddleware.DATA_UPLOAD_MAX_MEMORY_SIZE,
    // Keep the raw text: CPython's parse-error message quotes a character offset into it.
    verify: (request: Request, _response: Response, buffer: Buffer) => {
      setRawBody(request, buffer.toString('utf8'));
    },
  });

  private readonly urlencoded = express.urlencoded({
    extended: false,
    limit: DrfRequestParsingMiddleware.DATA_UPLOAD_MAX_MEMORY_SIZE,
  });

  /**
   * `MultiPartParser` — **Django's**, ported in `django-multipart.ts` (parity finding
   * **F8**), not multer's.
   *
   * multer wraps busboy, a strict RFC parser that aborts the request on anything malformed.
   * Django's parser raises in exactly three places and otherwise salvages what it can, so
   * the two disagree on every malformed body — in both directions, and across the 400/500
   * line. `django-multipart.ts` documents the nine measured rows.
   *
   * The body is read into a Buffer first, which is what multer's `memoryStorage` did too, so
   * nothing about the memory profile changes. Any field name is accepted, as in v1: the TSV
   * arrives as `file` (`services/user.py:132`, `services/loan.py`) and `FileView.post` reads
   * `name`, `file` and `type` out of the same merged dict.
   */
  private readonly multipart = (
    request: Request,
    _response: Response,
    next: NextFunction,
  ): void => {
    readRawBody(request, (error, body) => {
      if (error !== null) {
        next(error);
        return;
      }
      try {
        applyDjangoMultipart(request, body);
        next();
      } catch (parseError: unknown) {
        next(parseError);
      }
    });
  };

  use(request: Request, response: Response, next: NextFunction): void {
    // DRF's `request.data` is always dict-like, even when nothing was parsed: `_parse`
    // returns an empty `QueryDict`. Nest's own parser did the same, and the login
    // serializer distinguishes `{}` (missing fields -> 400) from `undefined`.
    request.body = {};

    if (!METHODS_THAT_READ_REQUEST_DATA.has(request.method)) {
      next();
      return;
    }

    const state: DrfParseState = {
      contentType: request.headers['content-type'] ?? '',
      hasBody: hasRequestBody(request),
      parseErrorDetail: null,
      suspiciousOperation: null,
    };
    setParseState(request, state);

    if (!state.hasBody) {
      next();
      return;
    }

    const selected = this.parserFor(state.contentType);
    if (selected === null) {
      // Unsupported media type: leave the body unread. The interceptor turns this into DRF's
      // 415 *after* authentication, and only if the handler really would have read the body.
      next();
      return;
    }

    selected.run.call(this, request, response, (error?: unknown) => {
      if (error instanceof DjangoSuspiciousOperation) {
        // Not a DRF `ParseError`: Django's own `SuspiciousOperation` handler answers 400
        // without ever reaching `finalize_response`. Deferred like the rest so an
        // unauthenticated oversized body still 401s.
        state.suspiciousOperation = error.message;
      } else if (error !== undefined && error !== null) {
        state.parseErrorDetail = this.describe(error, request, selected.kind);
      } else if (selected.kind !== 'json') {
        collapseMultiValueFields(request);
      }
      next();
    });
  }

  private parserFor(contentType: string): SelectedParser | null {
    const match = (parser: DrfParserMediaType): boolean => mediaTypeMatches(parser, contentType);
    if (match(DRF_PARSER_MEDIA_TYPES.JSON)) {
      return { kind: 'json', run: this.json as never };
    }
    if (match(DRF_PARSER_MEDIA_TYPES.FORM)) {
      return { kind: 'form', run: this.urlencoded as never };
    }
    if (match(DRF_PARSER_MEDIA_TYPES.MULTIPART)) {
      return { kind: 'multipart', run: this.multipart as never };
    }
    return null;
  }

  /**
   * Turns a body-parser / multer failure into the DRF `ParseError` detail string.
   *
   * ⚠️ Branching on **which parser ran** is reviewer finding **R5** (condition C11): the
   * previous version labelled every non-`SyntaxError` as `Multipart form parse error - …`,
   * so an over-sized *JSON* body returned
   * `{"detail": "Multipart form parse error - request entity too large"}` — a message about
   * a parser that never ran.
   *
   *  * `SyntaxError` from `express.json` → CPython's own message and offset, which is what
   *    `JSONParser.parse` puts in the body (`'JSON parse error - %s' % str(exc)`).
   *  * A multipart failure → Django's `MultiPartParserError`, which DRF renders as
   *    `Multipart form parse error - <message>`.
   *  * Anything else (in practice only `PayloadTooLargeError`) → DRF's own
   *    `ParseError.default_detail`, `'Malformed request.'`.
   *
   * ⚠️ Registered residual: the 2.5 MB limit is a **tightening**. DRF's `Request._load_stream`
   * streams the WSGI input directly and bypasses `DATA_UPLOAD_MAX_MEMORY_SIZE`, so v1 accepts
   * an arbitrarily large JSON body on any route. Kept anyway — an unbounded in-memory parse
   * is a denial-of-service primitive, and no v1 client posts megabytes of JSON (the bulk
   * uploads are multipart, where multer imposes no limit and matches Django's spill-to-disk).
   * See `docs/phase-1-drf-auth-bodies.md`.
   */
  private describe(error: unknown, request: Request, parser: ParserKind): string {
    if (parser === 'json' && error instanceof SyntaxError) {
      return drfJsonParseErrorDetail(getRawBody(request) ?? '');
    }
    if (parser === 'multipart' && error instanceof MultiPartParserError) {
      return `Multipart form parse error - ${error.message}`;
    }
    return 'Malformed request.';
  }
}

/**
 * Reads the whole request body into a Buffer, the way Django's `LazyStream`/`ChunkIter` pair
 * consumes the WSGI input.
 *
 * Deliberately unbounded, because `MultiPartParser` is: `DATA_UPLOAD_MAX_MEMORY_SIZE` is
 * applied by Django to non-file *fields* only (and is reproduced inside
 * {@link parseDjangoMultipart}), while an uploaded file may be arbitrarily large. multer's
 * `memoryStorage` — what this replaces — also held the whole body in memory, so the exposure
 * is unchanged.
 */
function readRawBody(request: Request, done: (error: Error | null, body: Buffer) => void): void {
  const chunks: Buffer[] = [];
  request.on('data', (chunk: Buffer) => chunks.push(chunk));
  request.on('end', () => done(null, Buffer.concat(chunks)));
  request.on('error', (error: Error) => done(error, Buffer.alloc(0)));
}

/**
 * Puts Django's `(POST, FILES)` on the request in the shape the rest of v2 already reads:
 * fields on `request.body` (as arrays, so {@link collapseMultiValueFields} can apply
 * `QueryDict.__getitem__`'s last-value-wins) and files on `request.files`, in multer's
 * `.any()` shape.
 *
 * ⚠️ One documented gap: DRF's `request.data` is `POST.copy()` **updated with** `FILES`, so a
 * name present in both resolves to the *file*. `readUploadedFile` looks only at
 * `request.files` and the DTOs look only at `request.body`, so v2 answers as if both existed
 * separately.
 *
 * ⚠️ That gap **is** observable on one route, measured in Phase 8: `FileView.post` checks
 * presence against the merged dict, so a `file` sent as a plain field, or a `name`/`type` sent
 * as a file part, is a 500 in v1. `common/http/drf-request-data.ts` reproduces the precedence
 * for that handler **without** merging values; no other handler calls it (grep at Phase 8's
 * commit: one caller).
 */
function applyDjangoMultipart(request: Request, body: Buffer): void {
  const result = parseDjangoMultipart(request.headers['content-type'] ?? '', body);

  const fields: Record<string, string[]> = {};
  for (const [name, values] of result.fields) {
    fields[name] = [...values];
  }
  request.body = fields;
  setUploadedFiles(request, result.files);
}

/**
 * `QueryDict` semantics for a repeated field — parity finding **F3**.
 *
 * DRF's `request.data` for a form or multipart body is a `QueryDict`, i.e. a
 * `MultiValueDict`: it keeps every value, but `data['x']` and `data.items()` both yield the
 * **last** one. That is what reaches the database — `HStoreField.get_prep_value` iterates
 * `value.items()` — so `endpoint=a&endpoint=b` stores `b` in v1.
 *
 * `express.urlencoded` and multer's `appendField` both build a JavaScript **array** for a
 * repeated key, which v2 then stored as the Python repr `"['a', 'b']"`. Collapsing to the
 * last value reproduces `QueryDict.__getitem__` for every consumer.
 *
 * The list-preserving half of `MultiValueDict` (`getlist`) is deliberately not reproduced:
 * **no v1 view calls it** (grepped across `fondo_api/`, tests excluded), so no behaviour
 * depends on the discarded values. If a Phase 3-8 handler ever needs them, this is the
 * single place that has to change.
 *
 * JSON bodies are untouched: CPython's `json.loads` and `JSON.parse` already agree that a
 * duplicated object key keeps the last value.
 */
function collapseMultiValueFields(request: Request): void {
  const body: unknown = request.body;
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return;
  }

  const fields = body as Record<string, unknown>;
  for (const key of Object.keys(fields)) {
    const value = fields[key];
    if (Array.isArray(value) && value.length > 0) {
      fields[key] = value[value.length - 1];
    }
  }
}

/** Which of DRF's three default parsers the `Content-Type` selected. */
type ParserKind = 'json' | 'form' | 'multipart';

interface SelectedParser {
  readonly kind: ParserKind;
  readonly run: (request: Request, response: Response, next: NextFunction) => void;
}

/** The methods whose v1 handlers read `request.data`. Verified across `fondo_api/views/`. */
const METHODS_THAT_READ_REQUEST_DATA = new Set(['POST', 'PUT', 'PATCH']);

/** What the middleware recorded, for {@link DrfParserInterceptor} to act on. */
export interface DrfParseState {
  /** The `Content-Type` header as sent, parameters included. Empty string when absent. */
  readonly contentType: string;
  /** `false` when DRF would have short-circuited to an empty `QueryDict`. */
  readonly hasBody: boolean;
  /** DRF's `ParseError` detail, or `null` when the body parsed (or was never read). */
  parseErrorDetail: string | null;
  /**
   * Django's `SuspiciousOperation` message (`RequestDataTooBig` / `TooManyFieldsSent`), or
   * `null`. A different failure class from a `ParseError`: it is raised by the multipart
   * parser, escapes DRF entirely and is answered by Django's own handler with a **400** —
   * so the body is Django's error page rather than DRF's `{"detail": ...}` envelope, and v2
   * renders the registered `{"message": ...}` analogue (D13).
   */
  suspiciousOperation: string | null;
}

const PARSE_STATE = Symbol('drfParseState');
const RAW_BODY = Symbol('drfRawBody');

/**
 * Records what the middleware found. Exported so {@link DrfParserInterceptor}'s unit test can
 * build a request without booting Express; production code should never call it.
 */
export function setParseState(request: Request, state: DrfParseState): void {
  (request as unknown as Record<symbol, unknown>)[PARSE_STATE] = state;
}

/** The parse state, or `undefined` for a method the middleware skipped. */
export function getParseState(request: Request): DrfParseState | undefined {
  return (request as unknown as Record<symbol, unknown>)[PARSE_STATE] as DrfParseState | undefined;
}

function setRawBody(request: Request, raw: string): void {
  (request as unknown as Record<symbol, unknown>)[RAW_BODY] = raw;
}

function getRawBody(request: Request): string | undefined {
  return (request as unknown as Record<symbol, unknown>)[RAW_BODY] as string | undefined;
}

/**
 * `Request._load_stream`: a body exists when `CONTENT_LENGTH` is non-zero, or when the body
 * is chunked (`Transfer-Encoding` present, which Django reports as an unknown length).
 */
function hasRequestBody(request: Request): boolean {
  const contentLength = Number(request.headers['content-length'] ?? '0');
  if (Number.isFinite(contentLength) && contentLength > 0) {
    return true;
  }
  return request.headers['transfer-encoding'] !== undefined;
}
