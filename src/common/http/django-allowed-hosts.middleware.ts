import { Injectable, Logger, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { AppConfigService } from '../../config/app-config.service';
import { DjangoStack, skipBeforeHeadersHooks } from './before-headers';
import { checkHost, effectiveAllowedHosts, rawHostOf } from './django-allowed-hosts';

/**
 * The **first** statement of `CommonMiddleware.process_request` that is not a no-op under
 * v1's settings: `host = request.get_host()` (`django/middleware/common.py:47`). Review
 * condition **C19**, finding **S3**.
 *
 * ## Why it is a separate class from {@link DjangoAppendSlashMiddleware}
 *
 * The two are the same Django middleware — slot 3 — split the way finding N1 split the URL
 * layer: one Nest middleware per step, registered in the order `process_request` runs them.
 * Both sit at slot 3, above `XFrameOptionsMiddleware` (7) and `corsheaders` (8), which is
 * what makes both of their short-circuits carry no `Vary`, no `X-Frame-Options` and no
 * `Access-Control-*`. Registering this **above** the `APPEND_SLASH` port is not cosmetic:
 * v1 answers `Host: evil.test` with a 400 even on `OPTIONS /password_reset`, which is a 301
 * for an allowed host, and on `OPTIONS /nope/nope`, which is a CORS-preflight 200. All three
 * measured.
 *
 * ## The 400 skips more than the `APPEND_SLASH` 301 does
 *
 * The 301 is *returned* from `process_request`, so `MiddlewareMixin.__call__` still runs
 * `CommonMiddleware.process_response` on it — which is where `Content-Length` comes from.
 * `DisallowedHost` is *raised*, so it is caught by the `convert_exception_to_response`
 * wrapper around slot 3 itself and slot 3's own response phase never runs. Live v1 shows
 * exactly that: the 400 carries **no `Content-Length`** and gunicorn falls back to
 * `Transfer-Encoding: chunked`, while the 301 carries `Content-Length: 0`. Hence
 * `skipBeforeHeadersHooks(response, DjangoStack.SESSION)` — slots 2 and 1 would still run,
 * slot 3 and everything below it does not. The `APPEND_SLASH` 301 next door passes
 * `DjangoStack.COMMON` instead, and the one-slot difference is exactly the `Content-Length`.
 *
 * ## Body
 *
 * v1 (`DEBUG = False`) renders Django's `bad_request` view: `Content-Type: text/html` and
 * the 26 bytes `<h1>Bad Request (400)</h1>`, with no trailing newline. v2 renders
 * `{"message":"Bad Request"}` as JSON, the same substitution already registered as **D13**
 * for the 404 and every other Django error page.
 */
@Injectable()
export class DjangoAllowedHostsMiddleware implements NestMiddleware {
  private readonly logger = new Logger('django.security.DisallowedHost');

  constructor(private readonly config: AppConfigService) {}

  use(request: Request, response: Response, next: NextFunction): void {
    const allowed = effectiveAllowedHosts(this.config.allowedHosts, this.config.debug);
    const verdict = checkHost(rawHostOf(request.headers), allowed);

    if (verdict.allowed) {
      next();
      return;
    }

    // `security_logger.error(str(exc), extra={'status_code': 400, 'request': request})`.
    this.logger.error(verdict.message);
    this.badRequest(response);
  }

  /** `convert_exception_to_response` → `get_exception_response(..., 400)` → `bad_request`. */
  private badRequest(response: Response): void {
    skipBeforeHeadersHooks(response, DjangoStack.SESSION);

    const body = JSON.stringify({ message: 'Bad Request' });

    // Express's `init` middleware runs above everything Nest registers. The hook that
    // normally strips this header sits at `DjangoStack.TRANSPORT` and would survive the skip,
    // but it is registered by a middleware *below* this one, which never runs on this path.
    response.removeHeader('X-Powered-By');
    response.statusCode = 400;
    // DRF's `application/json` without a charset, as everywhere else in v2. v1 sends
    // `text/html` because the body is Django's HTML error page (D13).
    response.setHeader('Content-Type', 'application/json');
    // ⚠️ v1 emits **no** `Content-Length` here (see the class comment) and chunks the body.
    // v2 sends the length rather than reproducing an artefact of a skipped response phase;
    // registered under P2-D8's transport residual.
    response.setHeader('Content-Length', String(Buffer.byteLength(body)));
    response.end(body);
  }
}
