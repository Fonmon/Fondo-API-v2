import { Injectable, type NestMiddleware } from '@nestjs/common';
import express, { type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
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

  private readonly json = express.json({
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
   * `MultiPartParser`. Memory storage mirrors Django's behaviour for a small upload
   * (`FILE_UPLOAD_MAX_MEMORY_SIZE`, 2.5 MB, spilling to disk above it); the monthly TSVs are
   * a few kilobytes. `.any()` because v1's parser accepts any field name — the TSV arrives as
   * `file` (`services/user.py:132`, `services/loan.py`), and `FileView.post` reads `name`,
   * `file` and `type` from the same merged dict.
   */
  private readonly multipart = multer({ storage: multer.memoryStorage() }).any();

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
    };
    setParseState(request, state);

    if (!state.hasBody) {
      next();
      return;
    }

    const runner = this.parserFor(state.contentType);
    if (runner === null) {
      // Unsupported media type: leave the body unread. The interceptor turns this into DRF's
      // 415 *after* authentication, and only if the handler really would have read the body.
      next();
      return;
    }

    runner.call(this, request, response, (error?: unknown) => {
      if (error !== undefined && error !== null) {
        state.parseErrorDetail = this.describe(error, request);
      }
      next();
    });
  }

  private parserFor(
    contentType: string,
  ): ((request: Request, response: Response, next: NextFunction) => void) | null {
    const match = (parser: DrfParserMediaType): boolean => mediaTypeMatches(parser, contentType);
    if (match(DRF_PARSER_MEDIA_TYPES.JSON)) {
      return this.json as never;
    }
    if (match(DRF_PARSER_MEDIA_TYPES.FORM)) {
      return this.urlencoded as never;
    }
    if (match(DRF_PARSER_MEDIA_TYPES.MULTIPART)) {
      return this.multipart as never;
    }
    return null;
  }

  /**
   * Turns a body-parser / multer failure into the DRF `ParseError` detail string.
   *
   * A `SyntaxError` from `express.json` is the only case v1 has a documented string for; a
   * multipart failure (`MulterError`) surfaces as Django's own `MultiPartParserError`
   * equivalent, and DRF renders that as `Multipart form parse error - <message>`.
   */
  private describe(error: unknown, request: Request): string {
    if (error instanceof SyntaxError) {
      return drfJsonParseErrorDetail(getRawBody(request) ?? '');
    }
    const message = error instanceof Error ? error.message : String(error);
    return `Multipart form parse error - ${message}`;
  }
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
