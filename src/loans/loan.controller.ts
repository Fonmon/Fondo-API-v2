import {
  All,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Role } from '../auth/permissions/roles';
import { V1View } from '../auth/decorators/v1-view.decorator';
import type { AuthenticatedUser } from '../auth/types/authenticated-user';
import { ApiException } from '../common/http/api.exception';
import { readUploadedFile } from '../common/http/django-multipart';
import { lastQueryValue } from '../common/http/django-query';
import { DrfNoRequestData } from '../common/http/drf-parser.interceptor';
import { DrfException } from '../common/http/drf.exception';
import type { PageEnvelope, UnpaginatedEnvelope } from '../common/http/pagination';
import { pythonInt } from '../common/utils/python-obj';
import type { LoanDto } from './dto/loan.serializers';
import { LoanService } from './loan.service';

/**
 * `fondo_api/views/loan.py:LoanView`, mounted by `url(r'^api/loan/?$', …, name='view_loan')`.
 *
 * `list_permissions['LoanView']` is `GET 3`, `POST 3`, `PATCH [0, 2]` — any member may list
 * and request; only ADMIN or TREASURER may upload the monthly file. There is **no `DELETE`
 * key**, so `DELETE /api/loan` is a 403 for every role including ADMIN (verified live).
 */
@V1View('LoanView')
@Controller('api/loan')
export class LoanController {
  constructor(private readonly loans: LoanService) {}

  /**
   * `LoanView.get`.
   *
   * ```python
   * user = user_service.get_profile(request.user.id)
   * all_loans = (request.query_params.get('all_loans') == 'true')
   * state = int(request.query_params.get('state', 4))
   * page = int(request.query_params.get('page', '1'))
   * paginate = True
   * if request.query_params.get('paginate') is not None:
   *     paginate = (request.query_params.get('paginate') == 'true')
   * if page <= 0:
   *     return Response({'message': 'Page number must be greater or equal than 0'}, 400)
   * if state > 4 or state < 0:
   *     return Response({'message': 'State must be between 0 and 4'}, 400)
   * if user.role <= 2:
   *     return Response(loan_service.get_loans(user.id, page, all_loans, state=state, paginate=paginate), 200)
   * return Response(loan_service.get_loans(user.id, page, state=state, paginate=paginate), 200)
   * ```
   *
   * Five v1 quirks, all reproduced:
   *
   *  * ⚠️ **`all_loans` is dropped for a MEMBER**, not refused — the argument is simply
   *    omitted from the second call, so `?all_loans=true` is a silent no-op for role 3 and
   *    returns only their own loans. `test_get_loans` asserts exactly that.
   *  * ⚠️ **The strings are compared, not parsed.** `all_loans=TRUE`, `all_loans=1` and
   *    `all_loans=yes` are all **false**; only the exact lowercase `true` counts. Same for
   *    `paginate`, whose *presence* switches it from the default `True` to
   *    `== 'true'` — so `?paginate=` (empty) means **false**.
   *  * ⚠️ **`int()` runs unguarded on both `state` and `page`**, unlike `UserView.get` which
   *    guards on presence. `?page=` and `?state=abc` are therefore **500**s, not 400s.
   *  * ⚠️ **The page check is `page <= 0` while the message says "greater or equal than 0"**.
   *    The message is wrong in v1 and is copied verbatim — a client may be matching on it.
   *  * ⚠️ **Order of the two 400s matters**: `?page=0&state=9` is the *page* message.
   *  * ⚠️ A repeated `?page=1&page=2` is `QueryDict.get`, i.e. the **last** value.
   *
   * `state` 4 means "every state"; `Loan.LOAN_STATES` only defines 0-3.
   */
  @Get()
  @HttpCode(HttpStatus.OK)
  async list(
    @CurrentUser() actor: AuthenticatedUser,
    @Query('all_loans') allLoansRaw?: string | string[],
    @Query('state') stateRaw?: string | string[],
    @Query('page') pageRaw?: string | string[],
    @Query('paginate') paginateRaw?: string | string[],
  ): Promise<PageEnvelope<LoanDto> | UnpaginatedEnvelope<LoanDto>> {
    const allLoans = lastQueryValue(allLoansRaw) === 'true';
    const state = pythonInt(lastQueryValue(stateRaw) ?? '4');
    const page = pythonInt(lastQueryValue(pageRaw) ?? '1');

    const paginateValue = lastQueryValue(paginateRaw);
    const paginate = paginateValue === undefined ? true : paginateValue === 'true';

    if (page <= 0) {
      throw ApiException.withMessage(
        HttpStatus.BAD_REQUEST,
        'Page number must be greater or equal than 0',
      );
    }
    if (state > 4 || state < 0) {
      throw ApiException.withMessage(HttpStatus.BAD_REQUEST, 'State must be between 0 and 4');
    }

    // `if user.role <= 2:` — `user_service.get_profile(request.user.id)` is already resolved
    // by the guard, and a caller with no profile row cannot get past it (default deny).
    const role = actor.profile?.role;
    const privileged = role !== undefined && role <= Role.TREASURER;

    return this.loans.getLoans(actor.id, page, privileged && allLoans, state, paginate);
  }

  /**
   * `LoanView.post`.
   *
   * ```python
   * state, msg = loan_service.create_loan(request.user.id, request.data)
   * if state: return Response({'id': msg}, status=201)
   * return Response({'message': msg}, status=406)
   * ```
   *
   * ⚠️ **The loan is always created for the caller**, whatever `user_id` the body carries.
   * Nothing here reads a target user.
   *
   * The `406` is v1's house style for a business-rule refusal on a create (§4 rule 2 — do not
   * modernise it into a 400/422). **D4**'s new lower-bound refusal is a **400**, per the
   * decided register row.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() body: unknown,
  ): Promise<{ id: number }> {
    return { id: await this.loans.createLoan(actor.id, body) };
  }

  /**
   * `LoanView.patch` — the treasurer's monthly loan file.
   *
   * ```python
   * @parser_classes((MultiPartParser,))
   * def patch(self, request):
   *     loan_service.bulk_update_loans(request.data)
   *     return Response(status=status.HTTP_200_OK)
   * ```
   *
   * ## ⚠️ The `@parser_classes` decorator is a **no-op** — do not "restore" the narrowing
   *
   * `rest_framework.decorators.parser_classes` is written for **function**-based views: it
   * sets the attribute on the decorated callable, and `APIView.dispatch` reads
   * `self.parser_classes` from the **class**. So `views/loan.py:49` accepts the **default**
   * parser list, JSON included, and then 500s inside the handler on the missing file part.
   * Plan §4 rule **12b**, and the identical finding on `UserView.patch` (P3) and
   * `FileView.post` (P8). Measured on live v1 for the P3 twin:
   *
   * | `Content-Type` | v1 |
   * |---|---|
   * | `application/json` | **500** — `obj['file']` raises `KeyError` |
   * | `application/x-www-form-urlencoded` | **500**, same |
   * | `multipart/form-data` with no `file` part | **500**, same |
   * | `text/plain` | **415** — outside the *default* list too |
   *
   * ## ⚠️ `readUploadedFile`, and rule 12c's no-merge
   *
   * v1 reads `obj['file']` and it only works because DRF merges `FILES` into `request.data`.
   * v2 does **not** implement that merge — it is the exact mechanism of deviation **D23** —
   * so the file is read from `request.files` explicitly, through the one shared helper
   * (condition **C36**; a second copy is how the merge gets re-implemented by accident).
   *
   * **D8** — the response is no longer a bodyless 200. It carries the ids this upload
   * auto-closed, which v1 discards. `manual-tester` must expect the body.
   */
  @Patch()
  @HttpCode(HttpStatus.OK)
  async bulkUpdate(@Req() request: Request): Promise<{ closed_loans: number[] }> {
    return this.loans.bulkUpdateLoans(readUploadedFile(request, 'file'));
  }

  /**
   * Keeps the unimplemented methods inside the guarded pipeline, so they 403 as in v1 rather
   * than 404ing in Nest's router (plan §4 rule 12).
   *
   * ⚠️ Unreachable in practice on a guarded DRF view: `APIView.initial()` checks permissions
   * **before** `dispatch` resolves a handler, and every method missing from `list_permissions`
   * — `DELETE`, `PUT`, `OPTIONS` — is denied there. The route exists to give `RolesGuard`
   * something to guard.
   */
  @DrfNoRequestData()
  @All()
  methodNotAllowed(@Req() request: Request): never {
    throw DrfException.methodNotAllowed(request.method, 'GET, POST, PATCH, HEAD, OPTIONS');
  }
}
