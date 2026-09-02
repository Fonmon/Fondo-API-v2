import {
  All,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { V1View } from '../auth/decorators/v1-view.decorator';
import type { AuthenticatedUser } from '../auth/types/authenticated-user';
import { ApiException } from '../common/http/api.exception';
import { DrfNoRequestData } from '../common/http/drf-parser.interceptor';
import { DrfException } from '../common/http/drf.exception';
import type { UserFullInfoDto } from './dto/user.serializers';
import { resolveDetailUserId, UserService } from './user.service';

/**
 * `fondo_api/views/user.py:UserDetailView`, mounted by
 * `url(r'^api/user/(?P<id>-?[0-9]+)$', …, name='view_user_detail')`.
 *
 * ⚠️ **Mounted at `/api/user/detail/:id`, which is not a URL any client can reach.**
 * `DjangoUrlResolverMiddleware` rewrites `/api/user/5` to it after v1's regex has decided that
 * `5` is an *id* and not an *app* — see `DjangoUrlPattern.dispatch`. Express cannot tell
 * `:id` from `:app`, and picking wrong is an authorisation decision (`DELETE /api/user/power`
 * is deny-all `UserAppsView` in v1, ADMIN-allowed `UserDetailView` under a naive Nest route).
 * A literal `GET /api/user/detail/5` from outside matches no v1 pattern and 404s at the
 * resolver.
 *
 * ```python
 * def get(self, request, id):
 *     id = int(id)
 *     if id == -1: id = request.user.id
 *     state, data = user_service.get_user(id)
 *     return Response(data, 200) if state else Response(status=404)
 *
 * def patch(self, request, id):
 *     id = int(id)
 *     state, code = user_service.update_user(id, request.data)
 *     if state: return Response(status=200)
 *     elif code == 404: return Response(status=404)
 *     return Response(status=409)
 *
 * def delete(self, request, id):
 *     id = int(id)
 *     return Response(status=200) if user_service.inactive_user(id) else Response(status=404)
 * ```
 *
 * `list_permissions['UserDetailView']` is `GET 3`, `PATCH 3`, `DELETE 0`. Everything finer —
 * who may write which section, who may change a `role` — is **D1**, and lives in
 * `UserService.updateUser`; the route-level matrix is unchanged so Phase 1's 280-cell parity
 * criterion still holds.
 */
@V1View('UserDetailView')
@Controller('api/user/detail')
export class UserDetailController {
  constructor(private readonly users: UserService) {}

  /** `UserDetailView.get`. `-1` means the caller (**D14**: unchanged from v1 on this verb). */
  @Get(':id')
  @HttpCode(HttpStatus.OK)
  async read(
    @Param('id') rawId: string,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<UserFullInfoDto> {
    return this.users.getUser(resolveDetailUserId(parseDetailId(rawId), actor, 'GET'));
  }

  /**
   * `UserDetailView.patch`.
   *
   * **D14** — `-1` now means the caller here too. v1 passes it straight through and 404s
   * *unconditionally*, for every caller, so no working client can depend on the old answer;
   * the change is inert against today's front end and stops the API telling a logged-in member
   * that they do not exist. Under D1 self-service is the dominant case for this endpoint, so
   * `GET` and `PATCH` disagreeing about how to say "me" is a trap for the next front end.
   *
   * Returns `200` with a **zero-byte** body, as `Response(status=200)` does.
   */
  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  async update(
    @Param('id') rawId: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Body() body: unknown,
  ): Promise<void> {
    await this.users.updateUser(
      actor,
      resolveDetailUserId(parseDetailId(rawId), actor, 'PATCH'),
      body,
    );
  }

  /**
   * `UserDetailView.delete` — a **soft** delete, ADMIN-only.
   *
   * **D14** — the `-1` sentinel is *not* adopted here and never resolves to the caller.
   * `fondodev` has exactly one ADMIN; `is_active` has no way back through the API
   * (`activate_user` needs a `key_activation`, which is NULL for all 15 members); so "me"
   * semantics on this verb is one mis-click from locking the fund out of its own
   * administration. Passing `-1` through 404s, which is what v1 does.
   */
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  async remove(@Param('id') rawId: string, @CurrentUser() actor: AuthenticatedUser): Promise<void> {
    await this.users.inactiveUser(resolveDetailUserId(parseDetailId(rawId), actor, 'DELETE'));
  }

  /** See `UserController.methodNotAllowed` — the route exists so the guard can run. */
  @DrfNoRequestData()
  @All(':id')
  methodNotAllowed(@Req() request: Request): never {
    throw DrfException.methodNotAllowed(request.method, 'GET, PATCH, DELETE, HEAD, OPTIONS');
  }
}

/**
 * `id = int(id)` on a segment the URL conf has already constrained to `-?[0-9]+`.
 *
 * ⚠️ Python's `int` is arbitrary precision and PostgreSQL happily compares an `integer`
 * column against an out-of-range numeric literal, so `GET /api/user/99999999999999999999`
 * is a plain **404** in v1 — it resolves, queries and misses. `Number()` would lose precision
 * and Prisma would reject the value as an `Int`, giving a 500 instead, so anything outside
 * the 32-bit range is turned into an id that cannot exist.
 */
function parseDetailId(raw: string): number {
  const value = BigInt(raw);
  if (value < -2147483648n || value > 2147483647n) {
    // No row can have this id; every handler's miss path is the 404 v1 produces.
    throw ApiException.empty(HttpStatus.NOT_FOUND);
  }
  return Number(value);
}
