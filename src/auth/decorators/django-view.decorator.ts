import { SetMetadata, type CustomDecorator, type ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { RequestWithDjangoRoute } from '../../common/http/django-url-conf';

export const IS_DJANGO_VIEW_KEY = 'fondo:isDjangoView';

/**
 * "The v1 counterpart of this controller is a **plain Django view**, not a DRF `APIView`."
 *
 * ## Why this is not `@Public()`
 *
 * `@Public()` is `permission_classes = []`: it clears `IsAuthenticated` and
 * `APIRolePermission` and leaves `authentication_classes` at the project default, so DRF
 * still runs `TokenAuthentication` and a malformed or unknown `Authorization: Token …`
 * header **401s** even on a public route. That is exactly right for `ObtainAuthToken` and
 * `UserActivateView`, which are DRF views.
 *
 * The four password-reset routes are not. `PasswordResetView`, `PasswordResetDoneView`,
 * `PasswordResetConfirmView` and `PasswordResetCompleteView` come from
 * `django.contrib.auth.views`; DRF is not in their stack **at all**. There is no
 * authenticator to run, so an `Authorization` header — valid, expired, invalid, or
 * belonging to a deactivated member — is an ordinary request header that Django ignores.
 * Measured on the live v1 across 24 cells (`{GET, OPTIONS, PUT}` × the four routes ×
 * {invalid token, inactive user's token}): 200 / 200 / 403 in every one, identical to the
 * same request without the header. v2 answered **401** — parity finding **F3**.
 *
 * The consequence is not cosmetic: the member most likely to send a stale token is the one
 * whose session broke, and the page v2 locked them out of is the password-reset page.
 *
 * ## The metadata alone does not unguard anything
 *
 * Both guards check {@link isPlainDjangoView}, which requires the decorator **and** the
 * agreement of `DjangoUrlResolverMiddleware`'s resolved route: a real v1 view (`view !==
 * null`) that the URL table records as having no DRF layer (`drf === null`). A decorator on
 * a DRF route, or on a route whose URL entry is missing, is ignored and the guards run —
 * i.e. the failure mode is "authentication still happens", never "authentication silently
 * stopped happening". The same table is what `RolesGuard` already trusts for C20.
 */
export const DjangoView = (): CustomDecorator<string> => SetMetadata(IS_DJANGO_VIEW_KEY, true);

/**
 * Whether this request is being handled by a controller that ports a plain Django view —
 * one with neither `authentication_classes` nor `permission_classes` because it is not a
 * DRF view.
 *
 * Fail-closed by construction: every disagreement between the decorator and the URL table
 * returns `false`, which leaves the guards running.
 */
export function isPlainDjangoView(reflector: Reflector, context: ExecutionContext): boolean {
  const declared = reflector.getAllAndOverride<boolean>(IS_DJANGO_VIEW_KEY, [
    context.getHandler(),
    context.getClass(),
  ]);
  if (declared !== true) {
    return false;
  }

  const route = context.switchToHttp().getRequest<Request & RequestWithDjangoRoute>().djangoRoute;
  // `view === null` is a v2-only route (`/health`); `drf !== null` is a DRF `APIView`.
  // Neither may borrow this exemption.
  return route !== undefined && route.view !== null && route.drf === null;
}
