import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * DRF renders authentication, permission and serializer failures through
 * `rest_framework.views.exception_handler`, which produces a body shape that is **not** v1's
 * usual `{'message': ...}`:
 *
 * ```python
 * if isinstance(exc.detail, (list, dict)):
 *     data = exc.detail          # e.g. {'username': ['This field is required.']}
 * else:
 *     data = {'detail': exc.detail}
 * ```
 *
 * and, for 401s raised while an authenticator advertises a challenge, adds
 * `WWW-Authenticate: <authenticate_header()>`
 * (`rest_framework/views.py:handle_exception`).
 *
 * v1 has **zero** tests asserting any of these bodies, so every string below was derived by
 * running the pinned stack (`Django==2.2.27`, `djangorestframework==3.11.2` from
 * `~/Projects/Fondo-API/requirements.txt`) under v1's exact `REST_FRAMEWORK` settings with
 * v1's `fondo_api/permissions.py` loaded verbatim. See `docs/phase-1-drf-auth-bodies.md`.
 *
 * `TokenAuthentication.authenticate_header()` returns the literal keyword `Token`, so every
 * authentication failure is a **401 with `WWW-Authenticate: Token`** — it is never coerced
 * to 403. Only `APIRolePermission` denials are 403.
 */
export class DrfException extends HttpException {
  /**
   * Public only so tests can write `expect(...).toThrow(DrfException)`. **Use the static
   * factories** — they are the enumeration of the four shapes DRF actually produces on the
   * routes this service exposes, and a hand-built instance is by definition not a captured
   * v1 response.
   */
  constructor(
    status: number,
    /** Rendered verbatim as the response body. */
    readonly drfBody: Record<string, unknown>,
    /** Response headers DRF attaches to this exception (`WWW-Authenticate`). */
    readonly drfHeaders: Readonly<Record<string, string>>,
  ) {
    super(drfBody, status);
  }

  /**
   * `NotAuthenticated` — raised by `APIView.permission_denied()` when a permission class
   * fails and no authenticator succeeded. This is the "no credentials" / "wrong scheme"
   * case: `TokenAuthentication.authenticate()` returns `None` without raising, then
   * `IsAuthenticated` fails.
   */
  static notAuthenticated(): DrfException {
    return new DrfException(
      HttpStatus.UNAUTHORIZED,
      { detail: 'Authentication credentials were not provided.' },
      WWW_AUTHENTICATE_TOKEN,
    );
  }

  /** `AuthenticationFailed(msg)` — raised from inside `TokenAuthentication.authenticate()`. */
  static authenticationFailed(detail: string): DrfException {
    return new DrfException(HttpStatus.UNAUTHORIZED, { detail }, WWW_AUTHENTICATE_TOKEN);
  }

  /**
   * `PermissionDenied` — raised by `APIView.permission_denied()` when a permission class
   * fails **and** an authenticator succeeded. In v1 this is always `APIRolePermission`
   * returning `False`, including its bare `except: return False` fallthrough.
   */
  static permissionDenied(): DrfException {
    return new DrfException(
      HttpStatus.FORBIDDEN,
      { detail: 'You do not have permission to perform this action.' },
      {},
    );
  }

  /**
   * `APIView.http_method_not_allowed` → `exceptions.MethodNotAllowed(request.method)`.
   *
   * DRF raises this from inside `dispatch()` **after** `initial()` has run, so an invalid
   * token on a wrong-method request produces the 401, not the 405. It also emits Django's
   * `Allow` header listing the view's handlers (e.g. `POST, OPTIONS` for `ObtainAuthToken`).
   *
   * ⚠️ Nest/Express answer **404** where DRF answers 405: the router simply has no route for
   * the method. Controllers that want parity have to add an explicit fallback handler; see
   * `AuthController.methodNotAllowed`. This is a cross-cutting concern for Phases 3-8, not
   * only for this route.
   */
  static methodNotAllowed(method: string, allow: string): DrfException {
    return new DrfException(
      HttpStatus.METHOD_NOT_ALLOWED,
      { detail: `Method "${method}" not allowed.` },
      { Allow: allow },
    );
  }

  /**
   * `exceptions.UnsupportedMediaType(media_type)` — raised by `Request.negotiate_parser`
   * when no parser matches the request's `Content-Type`
   * (`rest_framework/request.py:344`). DRF's `default_detail` is
   * `'Unsupported media type "{media_type}" in request.'` and `media_type` is the header as
   * sent, parameters included.
   *
   * Only reachable on a method whose view reads `request.data` (POST/PUT/PATCH in v1) and
   * only when the request actually carries a body — DRF returns an empty `QueryDict` without
   * negotiating when `CONTENT_LENGTH` is 0.
   */
  static unsupportedMediaType(mediaType: string): DrfException {
    return new DrfException(
      HttpStatus.UNSUPPORTED_MEDIA_TYPE,
      { detail: `Unsupported media type "${mediaType}" in request.` },
      {},
    );
  }

  /**
   * `exceptions.ParseError(detail)` — `JSONParser.parse` wraps CPython's own message:
   * `'JSON parse error - %s' % str(exc)` (`rest_framework/parsers.py:66`). The message text
   * is reproduced by `python-json.ts`, since it is part of the response body.
   */
  static parseError(detail: string): DrfException {
    return new DrfException(HttpStatus.BAD_REQUEST, { detail }, {});
  }

  /**
   * `serializers.ValidationError` surfaced by `serializer.is_valid(raise_exception=True)`.
   * `exc.detail` is already a dict, so DRF renders it **without** a `detail` wrapper.
   * Key order follows the serializer's field declaration order (`username`, then `password`).
   */
  static validationError(errors: Record<string, string[]>): DrfException {
    return new DrfException(HttpStatus.BAD_REQUEST, errors, {});
  }
}

/** `TokenAuthentication.authenticate_header()` returns `self.keyword`, i.e. `'Token'`. */
const WWW_AUTHENTICATE_TOKEN: Readonly<Record<string, string>> = Object.freeze({
  'WWW-Authenticate': 'Token',
});
