import {
  All,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { V1View } from '../auth/decorators/v1-view.decorator';
import type { AuthenticatedUser } from '../auth/types/authenticated-user';
import { ApiException } from '../common/http/api.exception';
import { DrfNoRequestData } from '../common/http/drf-parser.interceptor';
import { DrfException } from '../common/http/drf.exception';
import { NotificationService, UNSUBSCRIBE_OK } from './notification.service';

/**
 * `fondo_api/views/notification.py:NotificationView`, mounted by
 * `url(r'^api/notification/(?P<operation>[a-zA-Z]+)/?$', …, name='view_notification')`.
 *
 * ```python
 * def post(self, request, operation):
 *     if operation == 'subscribe':
 *         notification_service.save_subscription(request.user.id, request.data)
 *         return Response(status=status.HTTP_200_OK)
 *     elif operation == 'unsubscribe':
 *         state = notification_service.unregister_subscription(request.user.id, request.data)
 *         if state == 200:
 *             return Response(status=status.HTTP_200_OK)
 *         return Response(status=status.HTTP_404_NOT_FOUND)
 *     return Response(status=status.HTTP_405_METHOD_NOT_ALLOWED)
 * ```
 *
 * Every response is `Response(status=…)` with **no body** — DRF renders zero bytes, which is
 * what {@link ApiException.empty} and the `@HttpCode` + `void` return reproduce. In
 * particular the `405` for an unknown operation is a *view*-level status with an empty body,
 * **not** DRF's `{"detail": "Method … not allowed."}` envelope.
 *
 * ## The `@All()` fallback is load-bearing here, and not for the 405
 *
 * `list_permissions['NotificationView']` declares **only** `POST`. Every other method
 * therefore hits `APIRolePermission`'s bare `except: return False` and is a **403** for
 * every role — including ADMIN, and including `OPTIONS`. That happens inside
 * `APIView.initial()`, i.e. *before* `dispatch` could raise `MethodNotAllowed`, so a 405 is
 * unreachable on this route in v1. In Nest, a path with no route for `GET` 404s in the router
 * **before any guard runs**, so without {@link methodNotAllowed} v2 would answer 404 where v1
 * answers 403. The fallback exists to give the guard something to guard.
 */
@V1View('NotificationView')
@Controller('api/notification')
export class NotificationController {
  constructor(private readonly notifications: NotificationService) {}

  /**
   * `NotificationView.post`.
   *
   * @throws ApiException 404 (empty body) when the endpoint is not registered for this user,
   *   405 (empty body) for an operation that is neither `subscribe` nor `unsubscribe`.
   */
  @Post(':operation')
  @HttpCode(HttpStatus.OK)
  async post(
    @Param('operation') operation: string,
    @CurrentUser() user: AuthenticatedUser | undefined,
    @Body() body: unknown,
  ): Promise<void> {
    assertOperationMatchesUrlPattern(operation);

    // Unreachable: the route is guarded, so `RolesGuard` has already 401'd a caller without
    // a user. Narrowing rather than asserting keeps that fact checked instead of assumed.
    /* istanbul ignore next -- guarded route */
    if (user === undefined) {
      throw DrfException.notAuthenticated();
    }

    if (operation === 'subscribe') {
      await this.notifications.saveSubscription(user.id, body);
      return;
    }

    if (operation === 'unsubscribe') {
      const state = await this.notifications.unregisterSubscription(user.id, body);
      if (state === UNSUBSCRIBE_OK) {
        return;
      }
      throw ApiException.empty(HttpStatus.NOT_FOUND);
    }

    // v1's fallthrough: an empty-bodied 405, not DRF's `{"detail": …}` envelope.
    throw ApiException.empty(HttpStatus.METHOD_NOT_ALLOWED);
  }

  /**
   * Keeps non-POST methods inside the guarded pipeline so they 403 (see the class comment)
   * instead of 404ing in the router.
   *
   * Declared after {@link post} so Express matches the POST route first. Carries
   * `@DrfNoRequestData()` per condition **C10** — DRF never reads the body on this path.
   * `Allow: POST, OPTIONS` mirrors what Django would emit for a view defining only `post`.
   */
  @DrfNoRequestData()
  @All(':operation')
  methodNotAllowed(@Req() request: Request): never {
    throw DrfException.methodNotAllowed(request.method, 'POST, OPTIONS');
  }
}

/**
 * v1's URL regex constrains `operation` to `[a-zA-Z]+`; anything else fails URL resolution
 * and Django returns a 404 **before** authentication runs.
 *
 * v2 cannot express that constraint in the route: Express 5 / path-to-regexp v8 dropped
 * inline parameter patterns. Checking it in the handler reproduces the **status** but not the
 * **ordering** — an unauthenticated `POST /api/notification/sub1` is a 404 in v1 and a 401
 * here, because the guards run first. Registered in `docs/phase-2-deviations.md` as P2-D5 and
 * routed to the C9 work item, which is where Phase 3 transcribes v1's URL patterns properly
 * (v1's trailing-slash rules have the same shape of problem).
 */
function assertOperationMatchesUrlPattern(operation: string): void {
  if (!/^[a-zA-Z]+$/.test(operation)) {
    throw new NotFoundException();
  }
}
