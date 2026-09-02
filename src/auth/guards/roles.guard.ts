import {
  Injectable,
  InternalServerErrorException,
  Logger,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { RequestWithDjangoRoute } from '../../common/http/django-url-conf';
import { DrfException } from '../../common/http/drf.exception';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { V1_VIEW_KEY } from '../decorators/v1-view.decorator';
import { isRoleAllowed, type V1ViewName } from '../permissions/permission-matrix';
import type { RequestWithUser } from '../types/authenticated-user';

/**
 * v1's `DEFAULT_PERMISSION_CLASSES`, in order:
 *
 * ```python
 * 'rest_framework.permissions.IsAuthenticated',
 * 'fondo_api.permissions.APIRolePermission'
 * ```
 *
 * run by `APIView.check_permissions()` after authentication. `APIView.permission_denied()`
 * decides the status:
 *
 * ```python
 * if request.authenticators and not request.successful_authenticator:
 *     raise exceptions.NotAuthenticated()      # -> 401 + WWW-Authenticate: Token
 * raise exceptions.PermissionDenied(...)       # -> 403
 * ```
 *
 * `authentication_classes` is never empty in v1, so the split is simply: **no successful
 * authentication → 401; authenticated but disallowed → 403.**
 *
 * ## Default deny
 *
 * `APIRolePermission` wraps its whole body in a bare `try/except: return False`. A view
 * missing from `list_permissions`, a method missing from a view's entry, or a user with no
 * `userprofile` row all take that path and are **denied**, not allowed. {@link isRoleAllowed}
 * is total and returns `false` for each; this guard adds the one thing a dict lookup cannot
 * express — a controller that forgot `@V1View(...)` altogether is denied too, so a new route
 * is unreachable until someone deliberately registers it.
 *
 * ## The view name comes from the URL table, not from the Nest route — condition **C20**
 *
 * v1 authorises on `view.__class__.__name__`, and *which* class that is was decided by
 * Django's resolver: **first pattern in `urls.py` that matches**. Express decides it by
 * declaration order with unconstrained `:params`, which is a different function of the same
 * path. With one view per path the two agree by construction; `/api/user/<x>` has three, with
 * different rules, and there `DELETE /api/user/power` is `UserAppsView` (deny-all, no
 * `DELETE` entry) in v1 but would be `UserDetailView.DELETE` (ADMIN-allowed) under a
 * `:id`-first Nest controller. A routing detail would become an authorisation decision, and
 * it would not surface as a 404.
 *
 * So the guard consumes `request.djangoRoute`, which {@link DjangoUrlResolverMiddleware}
 * sets from the same table Django's resolver models, and treats a disagreement with the
 * declared `@V1View(...)` as a **v2 wiring bug**: a 500 with a loud log, never a plausible
 * 403 that hides a mis-ordered route. Three failure modes, all closed:
 *
 * | situation | outcome |
 * |---|---|
 * | no `@V1View(...)` on the controller | 403 — v1's `list_permissions[view_name]` `KeyError` |
 * | no resolved route (the URL layer did not run) | 403 — nothing may be authorised on a guess |
 * | resolved view ≠ declared view | **500**, logged — the request is about to reach the wrong handler |
 */
@Injectable()
export class RolesGuard implements CanActivate {
  private readonly logger = new Logger(RolesGuard.name);

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') {
      return true;
    }

    // `permission_classes = []` — clears IsAuthenticated *and* APIRolePermission.
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic === true) {
      return true;
    }

    const request = context
      .switchToHttp()
      .getRequest<Request & RequestWithUser & RequestWithDjangoRoute>();

    // `IsAuthenticated`: `bool(request.user and request.user.is_authenticated)`.
    if (request.authUser === undefined) {
      throw DrfException.notAuthenticated();
    }

    // `APIRolePermission`: `list_permissions[view.__class__.__name__][request.method]`.
    const viewName = this.v1ViewFor(context, request);

    if (!isRoleAllowed(viewName, request.method, request.authUser.profile?.role)) {
      throw DrfException.permissionDenied();
    }

    return true;
  }

  /**
   * `view.__class__.__name__` — as **Django's resolver** would have decided it (C20).
   *
   * Returns `undefined` for the two fail-closed cases, which {@link isRoleAllowed} then
   * denies exactly as v1's bare `except` does. Throws for the third, which is not a v1
   * situation at all but a v2 route/table disagreement.
   */
  private v1ViewFor(
    context: ExecutionContext,
    request: Request & RequestWithDjangoRoute,
  ): V1ViewName | undefined {
    const declared = this.reflector.getAllAndOverride<V1ViewName | undefined>(V1_VIEW_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (declared === undefined) {
      return undefined;
    }

    const route = request.djangoRoute;
    if (route === undefined) {
      // `DjangoUrlResolverMiddleware` sets this on every request it lets through, so this is
      // only reachable when a test or a future refactor mounts a guarded route outside
      // `AppModule`'s middleware chain. Deny rather than fall back to the declaration.
      this.logger.error(
        `${request.method} ${request.originalUrl}: no resolved v1 route on the request; ` +
          `refusing to authorise @V1View('${declared}') on the controller's word alone.`,
      );
      return undefined;
    }

    if (route.view !== declared) {
      // The URL table and the Nest router disagree about which v1 view answers this path.
      // Whichever is right, one of them is about to apply the wrong rules or run the wrong
      // handler, so fail loudly instead of picking a winner.
      this.logger.error(
        `${request.method} ${request.originalUrl}: v1 URL conf resolves to ` +
          `${route.view === null ? 'no v1 view' : `'${route.view}'`} but the matched Nest ` +
          `route declares @V1View('${declared}'). Check the route declaration order in the ` +
          'controller against the pattern order in DJANGO_URL_CONF.',
      );
      throw new InternalServerErrorException();
    }

    return declared;
  }
}
