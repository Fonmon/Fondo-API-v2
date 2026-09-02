import { SetMetadata, type CustomDecorator } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'fondo:isPublic';

/**
 * v1's `permission_classes = []` on a view class.
 *
 * It clears **both** default permissions (`IsAuthenticated` *and* `APIRolePermission`), so
 * an anonymous request is served. It does **not** clear `authentication_classes`: DRF still
 * runs `TokenAuthentication` first (`APIView.initial` calls `perform_authentication` before
 * `check_permissions`), which means a *malformed or unknown* `Authorization: Token …` header
 * still fails the request with 401 even on a public route. Verified against the running v1
 * stack; {@link TokenAuthGuard} reproduces it.
 *
 * Exactly two routes carry this in v1 and no more (`MIGRATION_PLAN.md` Phase 1):
 *  * `POST /api-token-auth` (`ObtainAuthToken.permission_classes = ()`) — Phase 1,
 *  * `POST /api/user/activate/<id>` (`UserActivateView`) — Phase 3.
 *
 * ⚠️ The four password-reset routes are **not** in that list, although this comment used to
 * say they were. `permission_classes` is a DRF attribute and they are `django.contrib.auth`
 * views: there is nothing to clear, and — the part that mattered — no authenticator to run
 * either. They carry `@DjangoView()` instead; see `django-view.decorator.ts` and parity
 * finding **F3**.
 *
 * `GET /health` also carries it: it is a v2-only route (deviation P0-D2) with no v1
 * counterpart, and it must answer before any credential exists.
 */
export const Public = (): CustomDecorator<string> => SetMetadata(IS_PUBLIC_KEY, true);
