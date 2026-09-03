import { All, Controller, HttpCode, HttpStatus, Logger, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { V1View } from '../auth/decorators/v1-view.decorator';
import type { AuthenticatedUser } from '../auth/types/authenticated-user';
import { ApiException } from '../common/http/api.exception';
import { assertRequestDataParsable, DrfNoRequestData } from '../common/http/drf-parser.interceptor';
import { DrfException } from '../common/http/drf.exception';
import type { PageEnvelope } from '../common/http/pagination';
import type { PowerDto, UserBirthdateDto } from './dto/user.serializers';
import { PowerService } from './power.service';
import { UserService } from './user.service';

/** `HttpStatus.FORBIDDEN` as a plain number, so the comparison is not an enum mismatch. */
const FORBIDDEN: number = HttpStatus.FORBIDDEN;

/**
 * `fondo_api/views/user.py:UserAppsView`, mounted by
 * `url(r'^api/user/(?P<app>-?[a-zA-Z]+)$', …, name='view_user_apps')`.
 *
 * ⚠️ **Mounted at `/api/user/apps/:app`, which no client can reach** — the resolver rewrites
 * `/api/user/power` to it once v1's `-?[a-zA-Z]+` has matched. See `DjangoUrlPattern.dispatch`
 * and {@link UserDetailController}.
 *
 * ```python
 * def post(self, request, app):
 *     try:
 *         if app == "birthdates":
 *             return Response(user_service.get_users_birthdate(), status=200)
 *         if app == "power":
 *             result = user_service.handle_power_request(request.user.id, request.data)
 *             return Response(result, status=200)
 *     except Exception as exception:
 *         logger.error('Exception executing an user app: %s', exception)
 *         return Response(status=500)
 *     else:
 *         return Response(status=404)
 * ```
 *
 * ## The `except Exception` is the contract, not a safety net
 *
 * **Everything** that can go wrong inside those two branches becomes a **zero-byte 500**: a
 * missing `type`, a missing `obj`, an unknown power id, a page below 1 — and, less obviously,
 * a **request-parsing failure**. `request.data` is evaluated as the argument to
 * `handle_power_request`, i.e. *inside* the `try`, so DRF's `UnsupportedMediaType` (415) and
 * `ParseError` (400) are `Exception`s like any other and are swallowed into the 500. That is
 * reproduced below rather than "fixed": `POST /api/user/power` with `Content-Type: text/plain`
 * is a **500** in v1.
 *
 * ⚠️ The `birthdates` branch never touches `request.data`, so it is a **200** for any
 * `Content-Type` — which is why the handler carries `@DrfNoRequestData()` and the `power`
 * branch calls {@link assertRequestDataParsable} itself (review condition **C10**, which names
 * this exact handler).
 *
 * The things deliberately **not** swallowed are the three v2-added controls on this route —
 * **D2**'s 403 (approving a power you were not asked to hold), **D26**'s 406
 * (`requester === requestee`, refused at creation) and **D27**'s 409 (an illegal power state
 * transition). Turning a deliberate refusal into v1's blanket 500 would hide it from the
 * caller and make `manual-tester` read it as an unrelated crash. See
 * {@link PowerService.createPower}, {@link PowerService.updatePower} and
 * {@link ApiException.deviation}.
 */
@V1View('UserAppsView')
@Controller('api/user/apps')
export class UserAppsController {
  private readonly logger = new Logger('UserAppsView');

  constructor(
    private readonly users: UserService,
    private readonly powers: PowerService,
  ) {}

  @DrfNoRequestData()
  @Post(':app')
  @HttpCode(HttpStatus.OK)
  async apps(
    @Param('app') app: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<UserBirthdateDto[] | PageEnvelope<PowerDto> | undefined> {
    try {
      if (app === 'birthdates') {
        return await this.users.getUsersBirthdate();
      }
      if (app === 'power') {
        // v1 evaluates `request.data` right here, inside the `try`.
        assertRequestDataParsable(request);
        return await this.powers.handlePowerRequest(actor, request.body);
      }
    } catch (error) {
      if (error instanceof ApiException && error.isDeviation) {
        // D26 (406) and D27 (409) — deliberate v2 controls. v1's blanket `except Exception`
        // would turn them into a 500, hiding the refusal from the caller and from
        // `manual-tester`. See `ApiException.deviation`.
        throw error;
      }
      if (error instanceof DrfException && error.getStatus() === FORBIDDEN) {
        // D2 — the requestee check. A v2 control; it must not be laundered into a 500.
        // Still a plain `DrfException`, so its body stays byte-identical to a role denial.
        throw error;
      }
      this.logger.error(
        `Exception executing an user app: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw ApiException.empty(HttpStatus.INTERNAL_SERVER_ERROR);
    }
    // v1's `else` clause: reached only when neither branch matched and nothing raised.
    throw ApiException.empty(HttpStatus.NOT_FOUND);
  }

  /**
   * See `UserController.methodNotAllowed`. `list_permissions['UserAppsView']` declares only
   * `POST`, so every other method — including `OPTIONS` and `DELETE` — is a **403** for every
   * role, decided by the guard before this handler could run.
   */
  @DrfNoRequestData()
  @All(':app')
  methodNotAllowed(@Req() request: Request): never {
    throw DrfException.methodNotAllowed(request.method, 'POST, OPTIONS');
  }
}
