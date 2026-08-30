import {
  ArgumentsHost,
  BadRequestException,
  ForbiddenException,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import { ApiExceptionFilter } from './api-exception.filter';
import { ApiException } from '../http/api.exception';

interface CapturedResponse {
  status: number | undefined;
  contentType: string | undefined;
  jsonBody: unknown;
  rawBody: string | undefined;
}

function makeHost(): { host: ArgumentsHost; captured: CapturedResponse } {
  const captured: CapturedResponse = {
    status: undefined,
    contentType: undefined,
    jsonBody: undefined,
    rawBody: undefined,
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
