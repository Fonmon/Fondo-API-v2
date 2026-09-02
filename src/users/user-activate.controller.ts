import { All, Body, Controller, HttpCode, HttpStatus, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '../auth/decorators/public.decorator';
import { DrfNoRequestData } from '../common/http/drf-parser.interceptor';
import { DrfException } from '../common/http/drf.exception';
import { UserService } from './user.service';

/**
 * `fondo_api/views/user.py:UserActivateView`, mounted by
 * `url(r'^api/user/activate/(?P<id>[0-9]+)$', …, name='view_user_activate')`.
 *
 * ```python
 * class UserActivateView(APIView):
 *     permission_classes = []
 *
 *     def post(self, request, id):
 *         state = user_service.activate_user(id, request.data)
 *         return Response(status=200) if state else Response(status=404)
 * ```
 *
 * `permission_classes = []` clears **both** defaults — `IsAuthenticated` and
 * `APIRolePermission` — so this route is genuinely public and `@Public()` is its exact
 * analogue. The credential is the `key_activation` in the body, which only the activation
 * email carries.
 *
 * ⚠️ Being public, it is the one `/api/user/…` route where DRF's **405** is reachable: there
 * is no permission check to refuse a `GET` first. `GET /api/user/activate/5` is
 * `405 {"detail": "Method \\"GET\\" not allowed."}` with `Allow: POST, OPTIONS`.
 *
 * ⚠️ It is also the route the round-3 URL sweep flagged as a classifier trap: a **404 here
 * means the view ran and refused**, not that the table failed to resolve. The `Allow` and
 * `Vary: Accept` headers on the response are what tell the two apart.
 */
@Public()
@Controller('api/user/activate')
export class UserActivateController {
  constructor(private readonly users: UserService) {}

  /**
   * ⚠️ v1 does **not** do `int(id)` here — the raw URL segment goes straight into
   * `UserProfile.objects.get(id=id, …)` and Django coerces it. The pattern is `[0-9]+`, so
   * the only observable difference is for an out-of-range value, which misses and 404s.
   */
  @Post(':id')
  @HttpCode(HttpStatus.OK)
  async activate(@Param('id') rawId: string, @Body() body: unknown): Promise<void> {
    await this.users.activateUser(parseActivationId(rawId), body);
  }

  /** Unlike the guarded views, this one really does reach DRF's 405. */
  @DrfNoRequestData()
  @All(':id')
  methodNotAllowed(@Req() request: Request): never {
    throw DrfException.methodNotAllowed(request.method, 'POST, OPTIONS');
  }
}

/**
 * An id outside PostgreSQL's `integer` range cannot match any row; Django/psycopg2 compare it
 * as a numeric literal and miss, so v1 answers 404. Prisma would reject it as an `Int`, so it
 * is folded to a value that cannot exist rather than reaching the query.
 */
function parseActivationId(raw: string): number {
  const value = BigInt(raw);
  return value > 2147483647n ? -1 : Number(value);
}
