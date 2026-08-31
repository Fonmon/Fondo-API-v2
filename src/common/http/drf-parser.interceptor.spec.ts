import { HttpStatus, type CallHandler, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { of } from 'rxjs';
import type { Request } from 'express';
import { DRF_PARSER_MEDIA_TYPES } from './drf-media-type';
import {
  assertRequestDataParsable,
  DrfNoRequestData,
  DrfParserInterceptor,
  DrfParsers,
  DRF_NO_REQUEST_DATA_KEY,
  DRF_PARSERS_KEY,
} from './drf-parser.interceptor';
import { DrfException } from './drf.exception';
import { setParseState, type DrfParseState } from './drf-request-parsing.middleware';

/**
 * §5 D18 / review finding S3 — the deferred half.
 *
 * `DrfRequestParsingMiddleware` never fails a request; this interceptor raises what it
 * recorded, at DRF's point in the pipeline: after `perform_authentication` and
 * `check_permissions`, before the handler touches `request.data`
 * (`rest_framework/views.py::dispatch`).
 */
describe('DrfParserInterceptor', () => {
  const handler: CallHandler = { handle: () => of('handled') };
  const interceptor = new DrfParserInterceptor(new Reflector());

  function contextFor(
    state: DrfParseState | undefined,
    parsers?: readonly string[],
    noRequestData = false,
  ): ExecutionContext {
    const request = {} as Request;
    if (state !== undefined) {
      setParseState(request, state);
    }

    const target = function handle(): void {};
    if (parsers !== undefined) {
      Reflect.defineMetadata(DRF_PARSERS_KEY, parsers, target);
    }
    if (noRequestData) {
      Reflect.defineMetadata(DRF_NO_REQUEST_DATA_KEY, true, target);
    }

    return {
      getType: () => 'http',
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => target,
      getClass: () => class ProbeController {},
    } as unknown as ExecutionContext;
  }

  function expectDrf(context: ExecutionContext): DrfException {
    try {
      interceptor.intercept(context, handler);
    } catch (error) {
      expect(error).toBeInstanceOf(DrfException);
      return error as DrfException;
    }
    throw new Error('expected the interceptor to throw a DrfException');
  }

  it('passes through a method the middleware skipped (GET, DELETE, HEAD, OPTIONS)', async () => {
    await expect(firstValueOf(interceptor.intercept(contextFor(undefined), handler))).resolves.toBe(
      'handled',
    );
  });

  it('passes through an empty body, whatever the Content-Type', async () => {
    // `_load_stream` sets the stream to None when CONTENT_LENGTH is 0, so DRF never
    // negotiates and an empty `text/plain` POST is a serializer 400, not a 415.
    const state: DrfParseState = {
      contentType: 'text/plain',
      hasBody: false,
      parseErrorDetail: null,
    };
    await expect(firstValueOf(interceptor.intercept(contextFor(state), handler))).resolves.toBe(
      'handled',
    );
  });

  it('passes through a body a parser claimed', async () => {
    const state: DrfParseState = {
      contentType: 'application/json; charset=utf-8',
      hasBody: true,
      parseErrorDetail: null,
    };
    await expect(firstValueOf(interceptor.intercept(contextFor(state), handler))).resolves.toBe(
      'handled',
    );
  });

  it('415s an unsupported media type, quoting the header as sent', () => {
    const error = expectDrf(
      contextFor({
        contentType: 'text/plain; charset=utf-8',
        hasBody: true,
        parseErrorDetail: null,
      }),
    );

    expect(error.getStatus()).toBe(HttpStatus.UNSUPPORTED_MEDIA_TYPE);
    expect(error.drfBody).toEqual({
      detail: 'Unsupported media type "text/plain; charset=utf-8" in request.',
    });
  });

  it("400s a recorded parse error with DRF's ParseError body", () => {
    const error = expectDrf(
      contextFor({
        contentType: 'application/json',
        hasBody: true,
        parseErrorDetail: 'JSON parse error - Expecting value: line 1 column 1 (char 0)',
      }),
    );

    expect(error.getStatus()).toBe(HttpStatus.BAD_REQUEST);
    expect(error.drfBody).toEqual({
      detail: 'JSON parse error - Expecting value: line 1 column 1 (char 0)',
    });
  });

  it('415s before it reports a parse error — negotiate_parser runs first', () => {
    const error = expectDrf(
      contextFor({
        contentType: 'text/plain',
        hasBody: true,
        parseErrorDetail: 'JSON parse error - Expecting value: line 1 column 1 (char 0)',
      }),
    );

    expect(error.getStatus()).toBe(HttpStatus.UNSUPPORTED_MEDIA_TYPE);
  });

  it('honours @DrfParsers — a JSON body on a multipart-only handler is a 415', () => {
    // `@parser_classes((MultiPartParser,))` on `views/user.py:36` and `views/loan.py:49`.
    const error = expectDrf(
      contextFor({ contentType: 'application/json', hasBody: true, parseErrorDetail: null }, [
        DRF_PARSER_MEDIA_TYPES.MULTIPART,
      ]),
    );

    expect(error.getStatus()).toBe(HttpStatus.UNSUPPORTED_MEDIA_TYPE);
    expect(error.drfBody).toEqual({
      detail: 'Unsupported media type "application/json" in request.',
    });
  });

  describe('C10 — @DrfNoRequestData bypasses negotiation entirely', () => {
    it('does not 415 an unsupported media type', async () => {
      // `PUT /api-token-auth` with `text/plain`: v1 raises MethodNotAllowed from
      // `dispatch` without ever touching `request.data`, so the 405 must win.
      const context = contextFor(
        { contentType: 'text/plain', hasBody: true, parseErrorDetail: null },
        undefined,
        true,
      );

      await expect(firstValueOf(interceptor.intercept(context, handler))).resolves.toBe('handled');
    });

    it('does not 400 a malformed JSON body', async () => {
      const context = contextFor(
        {
          contentType: 'application/json',
          hasBody: true,
          parseErrorDetail: 'JSON parse error - Expecting value: line 1 column 1 (char 0)',
        },
        undefined,
        true,
      );

      await expect(firstValueOf(interceptor.intercept(context, handler))).resolves.toBe('handled');
    });

    it('still 415s the same request without the marker — proving the marker is what changed', () => {
      const error = expectDrf(
        contextFor({ contentType: 'text/plain', hasBody: true, parseErrorDetail: null }),
      );
      expect(error.getStatus()).toBe(HttpStatus.UNSUPPORTED_MEDIA_TYPE);
    });

    it('records its metadata on the handler', () => {
      class Probe {
        @DrfNoRequestData()
        handle(): void {}
      }

      // eslint-disable-next-line @typescript-eslint/unbound-method -- reading metadata, not calling
      expect(Reflect.getMetadata(DRF_NO_REQUEST_DATA_KEY, Probe.prototype.handle)).toBe(true);
    });
  });

  describe('assertRequestDataParsable — for handlers where only some branches read the body', () => {
    function requestWith(state?: DrfParseState): Request {
      const request = {} as Request;
      if (state !== undefined) {
        setParseState(request, state);
      }
      return request;
    }

    it('is a no-op for a method the middleware skipped', () => {
      expect(() => assertRequestDataParsable(requestWith(undefined))).not.toThrow();
    });

    it('is a no-op for an empty body', () => {
      expect(() =>
        assertRequestDataParsable(
          requestWith({ contentType: 'text/plain', hasBody: false, parseErrorDetail: null }),
        ),
      ).not.toThrow();
    });

    it('raises DRF 415 for an unsupported media type', () => {
      expect(() =>
        assertRequestDataParsable(
          requestWith({ contentType: 'text/plain', hasBody: true, parseErrorDetail: null }),
        ),
      ).toThrow(DrfException);
    });

    it('raises DRF 400 carrying CPython’s parse-error message', () => {
      try {
        assertRequestDataParsable(
          requestWith({
            contentType: 'application/json',
            hasBody: true,
            parseErrorDetail: 'JSON parse error - Expecting value: line 1 column 1 (char 0)',
          }),
        );
        throw new Error('expected a DrfException');
      } catch (error) {
        expect(error).toBeInstanceOf(DrfException);
        expect((error as DrfException).drfBody).toEqual({
          detail: 'JSON parse error - Expecting value: line 1 column 1 (char 0)',
        });
      }
    });

    it('honours a narrowed parser list', () => {
      expect(() =>
        assertRequestDataParsable(
          requestWith({ contentType: 'application/json', hasBody: true, parseErrorDetail: null }),
          [DRF_PARSER_MEDIA_TYPES.MULTIPART],
        ),
      ).toThrow(DrfException);
    });
  });

  it('@DrfParsers records the media types it was given', () => {
    class Probe {
      @DrfParsers(DRF_PARSER_MEDIA_TYPES.MULTIPART)
      handle(): void {}
    }

    // eslint-disable-next-line @typescript-eslint/unbound-method -- reading metadata, not calling
    expect(Reflect.getMetadata(DRF_PARSERS_KEY, Probe.prototype.handle)).toEqual([
      'multipart/form-data',
    ]);
  });
});

function firstValueOf(observable: ReturnType<DrfParserInterceptor['intercept']>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    observable.subscribe({ next: resolve, error: reject });
  });
}
