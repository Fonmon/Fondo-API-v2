import { All, Body, Controller, HttpCode, HttpStatus, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { V1View } from '../auth/decorators/v1-view.decorator';
import type { AuthenticatedUser } from '../auth/types/authenticated-user';
import { ApiException } from '../common/http/api.exception';
import { DrfException } from '../common/http/drf.exception';
import { asPythonDict, pyGet, pyHas } from '../common/utils/python-obj';
import { LoanService, strptimeIsoDate } from './loan.service';
import { parseLoanPathId } from './loan-path-id';

/**
 * `fondo_api/views/loan.py:LoanAppsView`, mounted by
 * `url(r'^api/loan/(?P<id>[0-9]+)/(?P<app>[a-zA-Z]+)$', …, name='view_loan_apps')`.
 *
 * ```python
 * def post(self, request, id, app):
 *     if app == 'paymentProjection':
 *         if 'to_date' not in request.data:
 *             return Response(status=status.HTTP_400_BAD_REQUEST)
 *         try:
 *             to_date = datetime.strptime(request.data['to_date'], '%Y-%m-%d').date()
 *         except:
 *             return Response(status=status.HTTP_400_BAD_REQUEST)
 *         response = loan_service.payment_projection(id, to_date)
 *         if response is not None: return Response(response, status=200)
 *         return Response(response, status=404)
 *     if app == 'refinance':
 *         response = loan_service.refinance_loan(id, request.data, request.user.id)
 *         if response is not None: return Response({'id': response}, status=200)
 *         return Response(status=status.HTTP_400_BAD_REQUEST)
 *     return Response(status=status.HTTP_404_NOT_FOUND)
 * ```
 *
 * `list_permissions['LoanAppsView']` declares only `POST`, so every other method — `GET`,
 * `OPTIONS`, `DELETE` — is a **403** for every role.
 *
 * ⚠️ **`app` is matched case-sensitively against two camelCase literals.**
 * `/api/loan/1/paymentprojection` is a **404**, not a 400 — the URL regex `[a-zA-Z]+` admits
 * it and then neither branch matches. `DjangoUrlResolverMiddleware` already enforces the
 * character class; the case sensitivity is enforced here.
 *
 * ⚠️ **The two branches use *different* status codes for "no such loan"**: `paymentProjection`
 * answers 404, `refinance` answers 400, and both bodies are zero bytes. Do not unify them.
 *
 * ⚠️ **Only `refinance` is authorised in v1** — by `refinance_loan`'s own
 * `user_id != loan.user.id` check. `paymentProjection` was open to any member by id, which is
 * the second half of deviation **D10**; it is now restricted to the loan's owner plus roles
 * `[0, 1, 2]` inside {@link LoanService.paymentProjection}.
 */
@V1View('LoanAppsView')
@Controller('api/loan')
export class LoanAppsController {
  constructor(private readonly loans: LoanService) {}

  @Post(':id/:app')
  @HttpCode(HttpStatus.OK)
  async apps(
    @Param('id') rawId: string,
    @Param('app') app: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Body() body: unknown,
  ): Promise<{ interests: bigint; capital_balance: bigint } | { id: number }> {
    const id = parseLoanPathId(rawId);

    if (app === 'paymentProjection') {
      // `'to_date' not in request.data` — the key check comes first, so an absent body is a
      // 400 before anything is parsed as a date.
      const data = asPythonDict(body ?? {});
      if (!pyHas(data, 'to_date')) {
        throw ApiException.empty(HttpStatus.BAD_REQUEST);
      }
      let toDate;
      try {
        toDate = strptimeIsoDate(pyGet(data, 'to_date'));
      } catch {
        // v1's bare `except`: an empty string, a wrong format and a non-string are all 400.
        throw ApiException.empty(HttpStatus.BAD_REQUEST);
      }
      return this.loans.paymentProjection(actor, id, toDate);
    }

    if (app === 'refinance') {
      return { id: await this.loans.refinanceLoan(actor, id, body ?? {}) };
    }

    // Neither branch matched: v1 falls through to a zero-byte 404.
    throw ApiException.empty(HttpStatus.NOT_FOUND);
  }

  /** See `LoanController.methodNotAllowed` — the route exists so the guard can run. */
  @All(':id/:app')
  methodNotAllowed(@Req() request: Request): never {
    throw DrfException.methodNotAllowed(request.method, 'POST, OPTIONS');
  }
}
