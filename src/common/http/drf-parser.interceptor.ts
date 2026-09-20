import {
  HttpStatus,
  Injectable,
  SetMetadata,
  type CallHandler,
  type CustomDecorator,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { Observable } from 'rxjs';
import { ApiException } from './api.exception';
import { DrfException } from './drf.exception';
import {
  DEFAULT_PARSER_MEDIA_TYPES,
  selectParser,
  type DrfParserMediaType,
} from './drf-media-type';
import { getParseState } from './drf-request-parsing.middleware';

export const DRF_PARSERS_KEY = 'drf:parsers';

/**
 * The v2 equivalent of DRF's `@parser_classes((...))`.
 *
 * v1 narrows the parser list on exactly three handlers, all of them multipart uploads:
 * `UserView.patch` (`views/user.py:36`), `LoanView.patch` (`views/loan.py:49`) and
 * `FileView.post` (`views/file.py:15`). On those, a JSON body is a **415**, not a 400.
 * Everything else inherits `DEFAULT_PARSER_CLASSES`.
 *
 * @example
 * ＠DrfParsers(DRF_PARSER_MEDIA_TYPES.MULTIPART)
 * ＠Patch()
 * bulkUpdate(...) {}
 */
export function DrfParsers(...mediaTypes: readonly DrfParserMediaType[]): CustomDecorator<string> {
  return SetMetadata(DRF_PARSERS_KEY, mediaTypes);
}

export const DRF_NO_REQUEST_DATA_KEY = 'drf:noRequestData';

/**
 * Marks a handler that **never reads `request.data`** — reviewer findings R1 and R2,
 * review condition **C10**.
 *
 * DRF negotiates a parser lazily, the first time a view touches `request.data`. A handler
 * that never touches it therefore never 415s and never surfaces a JSON parse error, whatever
 * `Content-Type` the client sent. Nest has no equivalent laziness — the interceptor runs for
 * every handler — so without this marker v2 answers 415 where v1 answers 405 or 200.
 *
 * Two regressions this closes, both reproduced against the real pipeline:
 *
 * | Request | v1 | v2 without the marker |
 * |---|---|---|
 * | `PUT /api-token-auth`, `text/plain` + body | **405** `Method "PUT" not allowed.` | 415 |
 * | `PATCH /api-token-auth`, `application/json`, body `{` | **405** | 400 parse error |
 *
 * `APIView.dispatch` resolves `handler = self.http_method_not_allowed` and raises from there;
 * the body is never looked at. **Every `@All()` 405 fallback needs this marker** — plan
 * cross-cutting rule 12 adds one to every controller in Phases 3–8.
 *
 * ⚠️ Three v1 handlers also need it, and Phases 3 and 5 must apply it deliberately:
 *  * `ActivityYearView.post` (`views/activity.py:38`) — calls `create_year()` and ignores the
 *    body, so `POST /api/activity/year` with `text/plain` is a **201** in v1.
 *  * `UserAppsView.post` with `app == 'birthdates'` (`views/user.py:79`) — returns birthdates
 *    without reading the body. ⚠️ The `'power'` branch of the **same handler** *does* read it,
 *    so a decorator alone cannot express the rule: mark the handler, then call
 *    {@link assertRequestDataParsable} at the top of the `'power'` branch.
 *  * `PasswordResetView.post` (`views/auth.py:31`) is a plain **Django** view reading
 *    `request.POST`; it never negotiates a parser and so can never 415.
 */
export function DrfNoRequestData(): CustomDecorator<string> {
  return SetMetadata(DRF_NO_REQUEST_DATA_KEY, true);
}

/**
 * The parser negotiation itself, callable outside the interceptor.
 *
 * Exists for the one shape a decorator cannot express: a handler where only *some* branches
 * read `request.data` (`UserAppsView.post`, Phase 3). Mark such a handler with
 * {@link DrfNoRequestData} and call this at the top of the branches that do read the body.
 *
 * @throws DrfException 415 when no parser matches the request's `Content-Type`, or 400
 *   carrying CPython's own JSON parse-error message.
 * @throws ApiException 400 for a Django `SuspiciousOperation` raised by the multipart
 *   parser (`RequestDataTooBig`, `TooManyFieldsSent`).
 */
export function assertRequestDataParsable(
  request: Request,
  parsers: readonly DrfParserMediaType[] = DEFAULT_PARSER_MEDIA_TYPES,
): void {
  const state = getParseState(request);
  // `undefined` for GET/DELETE/HEAD/OPTIONS; `hasBody: false` is DRF's empty-QueryDict
  // short-circuit, which happens before any negotiation.
  if (state === undefined || !state.hasBody) {
    return;
  }
  if (selectParser(state.contentType, parsers) === null) {
    throw DrfException.unsupportedMediaType(state.contentType);
  }
  if (state.parseErrorDetail !== null) {
    throw DrfException.parseError(state.parseErrorDetail);
  }
  if (state.suspiciousOperation !== null) {
    // `RequestDataTooBig` / `TooManyFieldsSent` are `SuspiciousOperation`s, which Django's
    // own handler turns into a **400** before DRF sees them — so no `{"detail": ...}`
    // envelope and no `WWW-Authenticate`. v2 renders the registered `{"message": ...}`
    // analogue of Django's error page (D13), the same shape the URL resolver's 404 uses.
    throw ApiException.withMessage(HttpStatus.BAD_REQUEST, 'Bad Request');
  }
}

/**
 * Raises the request-parsing errors {@link DrfRequestParsingMiddleware} deferred, at the point
 * in the pipeline where DRF raises them.
 *
 * DRF order (`rest_framework/views.py::dispatch`):
 *
 * ```
 * initialize_request -> initial() -> perform_authentication  (401 here)
 *                                 -> check_permissions       (403 here)
 *                    -> handler(request)                     -> request.data
 *                                                               (415 / 400 here)
 * ```
 *
 * A Nest interceptor runs after the guards and before the handler, which is exactly that
 * seam — so a bad token on a `text/plain` body still 401s rather than 415ing, matching v1.
 */
@Injectable()
export class DrfParserInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    // C10: a handler that never touches `request.data` never negotiates a parser, so it can
    // neither 415 nor raise a JSON parse error. `@All()` 405 fallbacks are the common case.
    const noRequestData = this.reflector.getAllAndOverride<boolean | undefined>(
      DRF_NO_REQUEST_DATA_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (noRequestData === true) {
      return next.handle();
    }

    const request = context.switchToHttp().getRequest<Request>();

    const parsers =
      this.reflector.getAllAndOverride<readonly DrfParserMediaType[] | undefined>(DRF_PARSERS_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? DEFAULT_PARSER_MEDIA_TYPES;

    assertRequestDataParsable(request, parsers);

    return next.handle();
  }
}
