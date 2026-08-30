import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { DrfException } from '../../common/http/drf.exception';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { V1_VIEW_KEY } from '../decorators/v1-view.decorator';
import { isRoleAllowed } from '../permissions/permission-matrix';
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
 */
@Injectable()
export class RolesGuard implements CanActivate {
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

    const request = context.switchToHttp().getRequest<Request & RequestWithUser>();

    // `IsAuthenticated`: `bool(request.user and request.user.is_authenticated)`.
    if (request.authUser === undefined) {
      throw DrfException.notAuthenticated();
    }

    // `APIRolePermission`: `list_permissions[view.__class__.__name__][request.method]`.
    const viewName = this.reflector.getAllAndOverride<string>(V1_VIEW_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!isRoleAllowed(viewName, request.method, request.authUser.profile?.role)) {
      throw DrfException.permissionDenied();
    }

    return true;
  }
}
