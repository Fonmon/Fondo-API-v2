import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ApiException, type MessageBody } from '../http/api.exception';

/**
 * Global exception filter that renders errors the way v1's DRF views do.
 *
 * Three cases:
 *
 *  1. {@link ApiException} — the deliberate parity path. Renders its body verbatim, or a
 *     zero-byte body when it carries none.
 *  2. Any other `HttpException` (thrown by Nest itself: guards, pipes, the 404 handler).
 *     Normalised to v1's `{'message': '<string>'}` shape so a stray Nest default such as
 *     `{"statusCode":400,"message":["..."],"error":"Bad Request"}` can never leak.
 *  3. Anything else — logged with its stack and reported as a bare `500`. v1 would render a
 *     DRF/Django 500 here, which is an unhandled crash rather than a contract; v2 does not
 *     try to reproduce Django's debug page.
 *
 * ⚠️ The bodies DRF produces for authentication (`401`) and permission (`403`) failures are
 * `{"detail": "..."}`, not `{"message": "..."}`. v1 has **no test asserting them**, so the
 * exact strings must be captured from the running v1 service during Phase 1 and raised via
 * `ApiException.withMessage`-style helpers then. Until then this filter deliberately does
 * not guess.
 */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    const request = http.getRequest<Request>();

    if (exception instanceof ApiException) {
      this.send(response, exception.getStatus(), exception.body);
      return;
    }

    if (exception instanceof HttpException) {
      this.send(response, exception.getStatus(), {
        message: extractMessage(exception),
      });
      return;
    }

    this.logger.error(
      `Unhandled exception on ${request.method} ${request.url}`,
      exception instanceof Error ? exception.stack : String(exception),
    );
    this.send(response, HttpStatus.INTERNAL_SERVER_ERROR, undefined);
  }

  private send(response: Response, status: number, body: MessageBody | undefined): void {
    if (body === undefined) {
      // DRF's `Response(status=...)` renders zero bytes with a JSON content type.
      response.status(status).type('application/json').send('');
      return;
    }
    response.status(status).json(body);
  }
}

/** Pulls a single human-readable string out of whatever Nest put in the exception. */
function extractMessage(exception: HttpException): string {
  const payload: unknown = exception.getResponse();
  if (typeof payload === 'string') {
    return payload;
  }
  if (payload !== null && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    const candidate = record.message ?? record.detail;
    if (typeof candidate === 'string') {
      return candidate;
    }
    if (Array.isArray(candidate) && typeof candidate[0] === 'string') {
      return candidate[0];
    }
  }
  return exception.message;
}
