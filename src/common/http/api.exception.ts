import { HttpException } from '@nestjs/common';

/** The `{'message': '...'}` body v1 returns for most error paths. */
export interface MessageBody {
  message: string;
}

/**
 * Marker for "this response body is a deliberate parity reproduction of v1".
 *
 * v1's services return `(success: bool, payload_or_msg)` and its views translate that into
 * either `Response({'message': msg}, status)` or a bare `Response(status=...)` with **no
 * body at all**. Nest's defaults produce neither shape, so every error a controller or
 * service raises goes through this class and {@link ApiExceptionFilter} renders it byte for
 * byte.
 *
 * Status codes are v1's, including the ones a greenfield API would choose differently
 * (`406 Not Acceptable` for "no available quota", `409 Conflict` for a duplicate
 * identification). Cross-cutting rule §4.2: do not modernise them.
 */
export class ApiException extends HttpException {
  private constructor(
    status: number,
    /** `undefined` renders an empty body, matching DRF's `Response(status=...)`. */
    readonly body: MessageBody | undefined,
  ) {
    super(body ?? '', status);
  }

  /** `Response({'message': msg}, status=<status>)`. */
  static withMessage(status: number, message: string): ApiException {
    return new ApiException(status, { message });
  }

  /**
   * `Response(status=<status>)` — DRF renders a **zero-byte** body for this, not `null`
   * and not `{}`. Several v1 endpoints rely on it (`LoanDetailView.get` on a miss,
   * `UserDetailView.delete`, `NotificationView.post`).
   */
  static empty(status: number): ApiException {
    return new ApiException(status, undefined);
  }
}
