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
    /** See {@link ApiException.deviation}. */
    readonly isDeviation: boolean = false,
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

  /**
   * A refusal raised by a **deliberate v2 control** that v1 does not have — i.e. by a row in
   * `MIGRATION_PLAN.md` §5. Renders exactly like {@link withMessage}; the flag exists only so
   * a caller can tell the two apart.
   *
   * ## Why the flag exists
   *
   * `UserAppsView.post` wraps its whole body in `except Exception: return Response(status=500)`
   * (`views/user.py:57-68`), and v2 reproduces that faithfully. But the deviations added on
   * that route are *refusals*, not failures:
   *
   * | # | refusal |
   * |---|---|
   * | **D26** | a power request naming yourself → **406** at creation |
   * | **D27** | an illegal power state transition → **409**, no mail |
   *
   * Laundering either into v1's blanket 500 would hide the control from the caller *and* from
   * `manual-tester`, who would read it as an unrelated crash rather than as the registered
   * behaviour. So `UserAppsController` re-raises anything carrying this flag and swallows the
   * rest.
   *
   * ⚠️ **Not** for reproductions of v1's own error paths: those use {@link withMessage} and
   * *should* be swallowed where v1 swallows them. **D9**'s 409 does not need the flag either —
   * `LoanDetailView.patch` has no bare `except`, so nothing there swallows it.
   *
   * ⚠️ **D2** predates this and still throws `DrfException.permissionDenied()`, deliberately:
   * its body must be byte-identical to a role denial so an ownership failure is not a probe
   * for which ids exist. `UserAppsController` therefore checks for both.
   */
  static deviation(status: number, message: string): ApiException {
    return new ApiException(status, { message }, true);
  }
}
