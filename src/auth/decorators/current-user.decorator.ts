import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { AuthenticatedUser, RequestWithUser } from '../types/authenticated-user';

/**
 * v1's `request.user` inside a view body (`user_service.handle_power_request(request.user.id, ...)`).
 *
 * Only usable on routes behind {@link RolesGuard}; on a `@Public()` route the value may be
 * `undefined`, which is why the declared type includes it.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedUser | undefined => {
    const request = context.switchToHttp().getRequest<RequestWithUser>();
    return request.authUser;
  },
);
