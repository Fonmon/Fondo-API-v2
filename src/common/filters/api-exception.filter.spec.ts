import {
  ArgumentsHost,
  BadRequestException,
  ForbiddenException,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import { ApiExceptionFilter } from './api-exception.filter';
import { ApiException } from '../http/api.exception';
import { isDrfRendered } from '../http/drf-finalize-response';
import { DrfException } from '../http/drf.exception';

interface CapturedResponse {
  status: number | undefined;
  contentType: string | undefined;
  jsonBody: unknown;
  rawBody: string | undefined;
  headers: Record<string, string>;
}

function makeHost(): { host: ArgumentsHost; captured: CapturedResponse } {
  const captured: CapturedResponse = {
    status: undefined,
    contentType: undefined,
    jsonBody: undefined,
    rawBody: undefined,
    headers: {},
  };
  const response = {
    status(code: number) {
      captured.status = code;
      return this;
    },
    type(value: string) {
      captured.contentType = value;
      return this;
    },
    send(body: string) {
      captured.rawBody = body;
      return this;
    },
    json(body: unknown) {
      captured.jsonBody = body;
      return this;
    },
    setHeader(name: string, value: string) {
      captured.headers[name] = value;
      return this;
    },
  };
  const request = { method: 'GET', url: '/api/loan' };
  const host = {
    switchToHttp: () => ({
      getResponse: <T>() => response as T,
      getRequest: <T>() => request as T,
    }),
  } as unknown as ArgumentsHost;
  return { host, captured };
}

describe('ApiExceptionFilter', () => {
  let filter: ApiExceptionFilter;

  beforeEach(() => {
    filter = new ApiExceptionFilter();
    jest.spyOn(filter['logger'], 'error').mockImplementation(() => undefined);
  });

  describe('ApiException.withMessage — v1 Response({"message": msg}, status)', () => {
    it.each([
      [HttpStatus.BAD_REQUEST, 'Page number must be greater or equal than 0'],
      [HttpStatus.NOT_ACCEPTABLE, 'User does not have available quota'],
      [HttpStatus.CONFLICT, 'Identification/email already exists'],
      [HttpStatus.NOT_FOUND, 'Loan does not exist'],
    ])('renders %i with the exact v1 message', (status, message) => {
      const { host, captured } = makeHost();
      filter.catch(ApiException.withMessage(status, message), host);
      expect(captured.status).toBe(status);
      expect(captured.jsonBody).toEqual({ message });
    });

    it('preserves v1 status choices that a modern API would change', () => {
      // Cross-cutting rule 4.2: 406 and 409 stay as they are.
      const { host, captured } = makeHost();
      filter.catch(
        ApiException.withMessage(HttpStatus.NOT_ACCEPTABLE, 'User does not have available quota'),
        host,
      );
      expect(captured.status).toBe(406);
      expect(captured.status).not.toBe(400);
    });

    it('emits only the message key', () => {
      const { host, captured } = makeHost();
      filter.catch(ApiException.withMessage(404, 'Loan does not exist'), host);
      expect(Object.keys(captured.jsonBody as object)).toEqual(['message']);
    });
  });

  describe('ApiException.empty — v1 Response(status=...)', () => {
    it('writes a zero-byte body, not null and not {}', () => {
      const { host, captured } = makeHost();
      filter.catch(ApiException.empty(HttpStatus.NOT_FOUND), host);
      expect(captured.status).toBe(404);
      expect(captured.rawBody).toBe('');
      expect(captured.jsonBody).toBeUndefined();
    });

    it('keeps the JSON content type DRF uses', () => {
      const { host, captured } = makeHost();
      filter.catch(ApiException.empty(HttpStatus.METHOD_NOT_ALLOWED), host);
      expect(captured.contentType).toBe('application/json');
    });
  });

  describe('framework HttpExceptions', () => {
    it('normalises a Nest exception to the v1 {message} shape', () => {
      const { host, captured } = makeHost();
      filter.catch(new NotFoundException('Cannot GET /api/loan'), host);
      expect(captured.status).toBe(404);
      expect(captured.jsonBody).toEqual({ message: 'Cannot GET /api/loan' });
    });

    it("never leaks Nest's default {statusCode, message, error} envelope", () => {
      const { host, captured } = makeHost();
      filter.catch(new BadRequestException(['a must be a string']), host);
      expect(captured.jsonBody).toEqual({ message: 'a must be a string' });
      expect(captured.jsonBody).not.toHaveProperty('statusCode');
      expect(captured.jsonBody).not.toHaveProperty('error');
    });

    it('handles a guard rejection', () => {
      const { host, captured } = makeHost();
      filter.catch(new ForbiddenException(), host);
      expect(captured.status).toBe(403);
      expect(captured.jsonBody).toHaveProperty('message');
    });
  });

  describe('unexpected failures', () => {
    it('logs the stack and reports a bare 500', () => {
      const { host, captured } = makeHost();
      const logger = jest.spyOn(filter['logger'], 'error');
      filter.catch(new Error('database is on fire'), host);
      expect(captured.status).toBe(500);
      expect(captured.rawBody).toBe('');
      expect(logger).toHaveBeenCalled();
    });

    it('survives a thrown non-Error value', () => {
      const { host, captured } = makeHost();
      filter.catch('something odd', host);
      expect(captured.status).toBe(500);
    });
  });
});

describe('ApiExceptionFilter — DRF envelopes (Phase 1)', () => {
  let filter: ApiExceptionFilter;

  beforeEach(() => {
    filter = new ApiExceptionFilter();
  });

  it('renders NotAuthenticated as 401 {"detail"} with a Token challenge', () => {
    const { host, captured } = makeHost();
    filter.catch(DrfException.notAuthenticated(), host);
    expect(captured.status).toBe(401);
    expect(captured.jsonBody).toEqual({
      detail: 'Authentication credentials were not provided.',
    });
    expect(captured.headers).toEqual({ 'WWW-Authenticate': 'Token' });
  });

  it('renders AuthenticationFailed with the message the authenticator raised', () => {
    const { host, captured } = makeHost();
    filter.catch(DrfException.authenticationFailed('Invalid token.'), host);
    expect(captured.status).toBe(401);
    expect(captured.jsonBody).toEqual({ detail: 'Invalid token.' });
    expect(captured.headers).toEqual({ 'WWW-Authenticate': 'Token' });
  });

  it('renders PermissionDenied as 403 with no challenge header', () => {
    const { host, captured } = makeHost();
    filter.catch(DrfException.permissionDenied(), host);
    expect(captured.status).toBe(403);
    expect(captured.jsonBody).toEqual({
      detail: 'You do not have permission to perform this action.',
    });
    expect(captured.headers).toEqual({});
  });

  it('renders a serializer ValidationError dict without a `detail` wrapper', () => {
    const { host, captured } = makeHost();
    filter.catch(
      DrfException.validationError({
        username: ['This field is required.'],
        password: ['This field is required.'],
      }),
      host,
    );
    expect(captured.status).toBe(400);
    expect(captured.jsonBody).toEqual({
      username: ['This field is required.'],
      password: ['This field is required.'],
    });
    expect(Object.keys(captured.jsonBody as object)).toEqual(['username', 'password']);
  });

  it('renders MethodNotAllowed with the Allow header', () => {
    const { host, captured } = makeHost();
    filter.catch(DrfException.methodNotAllowed('GET', 'POST, OPTIONS'), host);
    expect(captured.status).toBe(405);
    expect(captured.jsonBody).toEqual({ detail: 'Method "GET" not allowed.' });
    expect(captured.headers).toEqual({ Allow: 'POST, OPTIONS' });
  });

  it("does not coerce a DRF body into v1's {message} shape", () => {
    const { host, captured } = makeHost();
    filter.catch(DrfException.permissionDenied(), host);
    expect(captured.jsonBody).not.toHaveProperty('message');
  });

  /**
   * Parity finding **F1**. `DjangoUrlResolverMiddleware` strips `Allow` and `Vary: Accept`
   * off a 500 because Django's exception handler builds a fresh response — but only an
   * *uncaught* exception takes that path. The two parity classes are marked here, at the one
   * place v2 renders a DRF `Response`.
   */
  describe('marks the responses DRF would have run finalize_response over', () => {
    function responseOf(host: ArgumentsHost): Parameters<typeof isDrfRendered>[0] {
      return host.switchToHttp().getResponse<Parameters<typeof isDrfRendered>[0]>();
    }

    it('marks an ApiException — v1 `Response(status=...)`, including the 500', () => {
      const { host } = makeHost();
      filter.catch(ApiException.empty(HttpStatus.INTERNAL_SERVER_ERROR), host);
      expect(isDrfRendered(responseOf(host))).toBe(true);
    });

    it('marks a DrfException — DRF’s own exception_handler returns a Response', () => {
      const { host } = makeHost();
      filter.catch(DrfException.permissionDenied(), host);
      expect(isDrfRendered(responseOf(host))).toBe(true);
    });

    it('does NOT mark an unhandled exception — Django threw that response away', () => {
      const { host } = makeHost();
      filter.catch(new TypeError('boom'), host);
      expect(isDrfRendered(responseOf(host))).toBe(false);
    });

    it('does NOT mark a bare Nest HttpException — no v1 counterpart to keep headers for', () => {
      const { host } = makeHost();
      filter.catch(new NotFoundException(), host);
      expect(isDrfRendered(responseOf(host))).toBe(false);
    });
  });
});
