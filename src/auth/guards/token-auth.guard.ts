import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { DrfException } from '../../common/http/drf.exception';
import { AuthService } from '../auth.service';
import { isPlainDjangoView } from '../decorators/django-view.decorator';
import type { RequestWithUser } from '../types/authenticated-user';

/**
 * `rest_framework.authentication.TokenAuthentication`, run at the point DRF runs it:
 * `APIView.initial()` calls `perform_authentication()` **before** `check_permissions()`.
 *
 * Consequences that this ordering makes observable, all verified against the pinned v1
 * stack:
 *
 *  * A malformed or unknown token fails with **401 before any permission check**, so it does
 *    so even on `@Public()` routes — `permission_classes = []` clears permissions, never
 *    authenticators. `POST /api-token-auth` with `Authorization: Token <garbage>` is a 401,
 *    not a login attempt.
 *  * A *missing* or *wrong-scheme* header is **not** an error here.
 *    `TokenAuthentication.authenticate()` returns `None` when the header is absent or does
 *    not start with `Token`, and the request continues as anonymous. The 401 for that case
 *    is produced later by `IsAuthenticated`, in {@link RolesGuard}, with a different body.
 *  * Scheme matching is **case-insensitive** (`auth[0].lower() != keyword.lower()`), so
 *    `authorization: token <key>` authenticates.
 *
 * This guard therefore never denies for "no credentials"; it only ever throws for a header
 * that claims to carry a token and fails to.
 *
 * ⚠️ **And only on DRF routes.** `authentication_classes` is a DRF concept; the four
 * `django.contrib.auth` password-reset views have no DRF layer at all, so an `Authorization`
 * header there is an ordinary header Django ignores. `@DjangoView()` marks those controllers
 * and this guard steps aside for them — parity finding **F3**, where a bad token turned the
 * account-recovery page into a 401. See {@link isPlainDjangoView} for why the decorator alone
 * is not enough to earn the exemption.
 */
@Injectable()
export class TokenAuthGuard implements CanActivate {
  /** `TokenAuthentication.keyword`. */
  static readonly KEYWORD = 'token';

  constructor(
    private readonly authService: AuthService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') {
      return true;
    }

    // Not a DRF view -> no `authentication_classes` -> the header is never read (F3).
    if (isPlainDjangoView(this.reflector, context)) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request & RequestWithUser>();
    const key = extractTokenKey(request.headers.authorization);
    if (key === null) {
      return true;
    }

    const authentication = await this.authService.authenticateByTokenKey(key);
    if (authentication === null) {
      throw DrfException.authenticationFailed('Invalid token.');
    }
    if (!authentication.user.isActive) {
      throw DrfException.authenticationFailed('User inactive or deleted.');
    }

    request.authUser = authentication.user;
    request.authToken = authentication.token;
    return true;
  }
}

/**
 * `rest_framework.authentication.get_authorization_header` + the header-shape half of
 * `TokenAuthentication.authenticate`.
 *
 * ```python
 * auth = get_authorization_header(request).split()
 * if not auth or auth[0].lower() != self.keyword.lower().encode():
 *     return None
 * if len(auth) == 1:   raise AuthenticationFailed('Invalid token header. No credentials provided.')
 * elif len(auth) > 2:  raise AuthenticationFailed('Invalid token header. Token string should not contain spaces.')
 * try:    token = auth[1].decode()
 * except UnicodeError: raise AuthenticationFailed('Invalid token header. Token string should not contain invalid characters.')
 * ```
 *
 * Returns `null` for "no credentials, carry on anonymously"; throws for a malformed
 * `Token …` header.
 */
export function extractTokenKey(header: string | undefined): string | null {
  if (header === undefined) {
    return null;
  }

  // Python's `bytes.split()` with no argument splits on runs of any whitespace and discards
  // leading/trailing empties, which `''.split()` -> `[]` also relies on.
  const parts = header.split(/\s+/u).filter((part) => part.length > 0);

  if (parts.length === 0 || parts[0].toLowerCase() !== TokenAuthGuard.KEYWORD) {
    return null;
  }
  if (parts.length === 1) {
    throw DrfException.authenticationFailed('Invalid token header. No credentials provided.');
  }
  if (parts.length > 2) {
    throw DrfException.authenticationFailed(
      'Invalid token header. Token string should not contain spaces.',
    );
  }

  return decodeTokenSegment(parts[1]);
}

/**
 * `auth[1].decode()` — the token bytes are UTF-8-decoded, but the header was read as
 * **latin-1** (`HTTP_HEADER_ENCODING = 'iso-8859-1'`). Node's HTTP parser also surfaces
 * header values as latin-1 text, so re-encoding to bytes and strict-decoding as UTF-8
 * reproduces Django's `UnicodeError` on exactly the same inputs (e.g. a header value
 * containing `ñ`).
 */
function decodeTokenSegment(segment: string): string {
  const bytes = Buffer.from(segment, 'latin1');
  if (bytes.toString('latin1') !== segment) {
    // Characters outside latin-1 cannot have come from a conforming HTTP header; Django
    // would have raised UnicodeEncodeError while *reading* it.
    throw DrfException.authenticationFailed(
      'Invalid token header. Token string should not contain invalid characters.',
    );
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw DrfException.authenticationFailed(
      'Invalid token header. Token string should not contain invalid characters.',
    );
  }
}
