import {
  All,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response as ExpressResponse } from 'express';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { V1View } from '../auth/decorators/v1-view.decorator';
import type { AuthenticatedUser } from '../auth/types/authenticated-user';
import { ApiException } from '../common/http/api.exception';
import { DrfNoRequestData } from '../common/http/drf-parser.interceptor';
import { DrfException } from '../common/http/drf.exception';
import { sendDrfBody } from '../common/http/drf-response';
import { asPythonDict, pyGet, toDjangoSmallInt } from '../common/utils/python-obj';
import type { LoanDetailDto, LoanDto } from './dto/loan.serializers';
import { LoanService } from './loan.service';
import { parseLoanPathId } from './loan-path-id';

/**
 * `fondo_api/views/loan.py:LoanDetailView`, mounted by
 * `url(r'^api/loan/(?P<id>[0-9]+)$', …, name='view_loan_detail')`.
 *
 * ⚠️ **No trailing `/?`** in v1's pattern, so `/api/loan/5/` is a **404** —
 * `DjangoUrlResolverMiddleware` enforces that before the guards (finding S7,
 * `docs/adding-a-route.md` §1).
 *
 * `list_permissions['LoanDetailView']` is `GET 3`, `PATCH [0, 2]`.
 *
 * ## ⚠️ The `PATCH [0, 2]` cell is carried **deliberately** — withdrawn deviation D28
 *
 * `update_loan(id, state)` never receives the actor's id (`services/loan.py:79`), so there is
 * no ownership check and **a TREASURER can approve their own loan**. Operator **Q31**
 * confirmed this is normal fund practice, D28 was **withdrawn** on 2026-09-03, and `m6` (a
 * TREASURER writing their own `finance`) is accepted with it. Both port from v1 unchanged.
 * See `docs/operator-q29a-q30a-q31.md` — this comment exists so a future reader finds a
 * decision here, not an oversight.
 */
@V1View('LoanDetailView')
@Controller('api/loan')
export class LoanDetailController {
  constructor(private readonly loans: LoanService) {}

  /**
   * `LoanDetailView.get`.
   *
   * ```python
   * state, data = loan_service.get_loan(id)
   * if state: return Response(data, status=200)
   * return Response(status=404)          # zero-byte body
   * ```
   *
   * **D10** (operator Q16) — restricted to the loan's owner plus roles `[0, 1, 2]`. v1 lets
   * any member read any loan by id, including its value, rate and comments. The refusal is
   * DRF's generic 403, identical to a role denial, so it cannot be used to enumerate loans
   * belonging to other members.
   *
   * D10's twin, **D25**, restricts `GET /api/user/<id>` with the *same* predicate and the
   * *same* roles, and lands in this phase for exactly that reason.
   */
  @Get(':id')
  @HttpCode(HttpStatus.OK)
  async read(
    @Param('id') rawId: string,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<{ loan: LoanDto; loan_detail?: LoanDetailDto }> {
    return this.loans.getLoan(actor, parseLoanPathId(rawId));
  }

  /**
   * `LoanDetailView.patch`.
   *
   * ```python
   * new_state = int(request.data['state'])
   * if new_state <= 3:
   *     state, msg = loan_service.update_loan(id, new_state)
   *     if state: return Response(msg, status=200)
   *     return Response({'message': msg}, status.HTTP_404_NOT_FOUND)
   * return Response({'message': 'State must be less or equal than 3'}, status=400)
   * ```
   *
   * ⚠️ **There is no lower bound.** `{"state": -1}` passes `new_state <= 3` and v1 writes
   * `-1` into the column. **D9** now refuses it as an illegal transition (409) — the loan is
   * looked up first, so a missing id is still v1's 404.
   *
   * ⚠️ **A missing `state` key is a `KeyError` → 500**, not a 400: nothing wraps the
   * subscript. `{"state": "abc"}` is a `ValueError` → 500 for the same reason.
   *
   * ⚠️ **`Response(msg, 200)` with `msg = ''` renders the two bytes `""`**, not an empty
   * body — `JSONRenderer` returns `b''` only for `None`. So a denial or a payout answers
   * `200` with a JSON **string**, and only an approval answers the serialised `LoanDetail`.
   */
  @Patch(':id')
  async update(
    @Param('id') rawId: string,
    @Body() body: unknown,
    @Res() response: ExpressResponse,
  ): Promise<void> {
    const newState = toDjangoSmallInt(pyGet(asPythonDict(body), 'state'), 'state');
    if (newState > 3) {
      throw ApiException.withMessage(HttpStatus.BAD_REQUEST, 'State must be less or equal than 3');
    }
    const result = await this.loans.updateLoan(parseLoanPathId(rawId), newState);
    // ⚠️ `@Res()` rather than a return value, and {@link sendDrfBody} rather than Nest's
    // `reply`: the `''` case must reach the wire as the two bytes `""`, and Nest sends a
    // zero-byte body for any non-object. See `common/http/drf-response.ts`.
    sendDrfBody(response, HttpStatus.OK, result);
  }

  /** See `LoanController.methodNotAllowed` — the route exists so the guard can run. */
  @DrfNoRequestData()
  @All(':id')
  methodNotAllowed(@Req() request: Request): never {
    throw DrfException.methodNotAllowed(request.method, 'GET, PATCH, HEAD, OPTIONS');
  }
}
