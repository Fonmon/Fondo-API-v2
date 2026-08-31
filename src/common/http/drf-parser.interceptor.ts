import {
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

    const request = context.switchToHttp().getRequest<Request>();
    const state = getParseState(request);
    // `undefined` for GET/DELETE/HEAD/OPTIONS: v1 never touches `request.data` there.
    if (state === undefined || !state.hasBody) {
      return next.handle();
    }

    const parsers =
      this.reflector.getAllAndOverride<readonly DrfParserMediaType[] | undefined>(DRF_PARSERS_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? DEFAULT_PARSER_MEDIA_TYPES;

    if (selectParser(state.contentType, parsers) === null) {
      throw DrfException.unsupportedMediaType(state.contentType);
    }
    if (state.parseErrorDetail !== null) {
      throw DrfException.parseError(state.parseErrorDetail);
    }

    return next.handle();
  }
}
