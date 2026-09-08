import {
  All,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { V1View } from '../auth/decorators/v1-view.decorator';
import { Role } from '../auth/permissions/roles';
import type { AuthenticatedUser } from '../auth/types/authenticated-user';
import { ApiException } from '../common/http/api.exception';
import { lastQueryValue } from '../common/http/django-query';
import { DrfNoRequestData } from '../common/http/drf-parser.interceptor';
import { DrfException } from '../common/http/drf.exception';
import type { PageEnvelope, UnpaginatedEnvelope } from '../common/http/pagination';
import { pythonInt } from '../common/utils/python-obj';
import type { SavingAccountDto } from './dto/saving-account.serializers';
import { SavingAccountService } from './saving-account.service';

/**
 * `fondo_api/views/saving_account.py:SavingAccountView`, mounted by
 * `url(r'^api/saving-account/?$', …, name='view_saving_account')` — trailing slash
 * **optional**, so `/api/saving-account/` resolves too.
 *
 * `list_permissions['SavingAccountView']` is `GET 3`, `POST 3`, `PUT [0, 2]`. The `PUT` rule
 * is a **list**, i.e. exact membership, so PRESIDENT (1) is excluded — deliberately
 * (operator **Q23**), and the register row that proposed widening it (**D3**) is *withdrawn*.
 * There is no `PATCH` and no `DELETE` key, so both are a **403** for every role including
 * ADMIN.
 */
@V1View('SavingAccountView')
@Controller('api/saving-account')
export class SavingAccountController {
  constructor(private readonly accounts: SavingAccountService) {}

  /**
   * `SavingAccountView.post`.
   *
   * ```python
   * account_id = saving_account_service.create_account(request.user.id, request.data)
   * return Response({'id': account_id}, status=status.HTTP_200_OK)
   * ```
   *
   * ⚠️ **200, not 201** — on a call that creates a row and returns its id. `LoanView.post`,
   * three files away, answers **201** for the same shape. It is v1's contract and a client
   * may be matching on it (plan §4 rule 2: do not modernise a status code).
   */
  @Post()
  @HttpCode(HttpStatus.OK)
  async create(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() body: unknown,
  ): Promise<{ id: number }> {
    return { id: await this.accounts.createAccount(actor.id, body) };
  }

  /**
   * `SavingAccountView.get`.
   *
   * ```python
   * user = user_service.get_profile(request.user.id)
   * all_accounts = (request.query_params.get('all_accounts') == 'true')
   * state = int(request.query_params.get('state', 0))
   * page = int(request.query_params.get('page', 1))
   * paginate = True
   * if request.query_params.get('paginate') is not None:
   *     paginate = (request.query_params.get('paginate') == 'true')
   * if page <= 0:
   *     return Response({'message': 'Page number must be greater or equal than 0'}, 400)
   * if state > 1 or state < 0:
   *     return Response({'message': 'State must be between 0 and 1'}, 400)
   * if user.role <= 2:
   *     return Response(saving_account_service.get_accounts(user.id, page, all_accounts, state=state, paginate=paginate), 200)
   * return Response(saving_account_service.get_accounts(user.id, page, state=state, paginate=paginate), 200)
   * ```
   *
   * Everything below is reproduced rather than tidied:
   *
   *  * ⚠️ **`all_accounts` is dropped for a MEMBER, not refused.** Role 3 simply gets the
   *    second call, which omits the argument, so `?all_accounts=true` is a **silent no-op**
   *    returning only their own CAPs — a 200 with a narrower list, never a 403.
   *  * ⚠️ **The strings are compared, not parsed.** `all_accounts=TRUE`, `=1` and `=yes` are
   *    all false; only the exact lowercase `true` counts. `paginate` is different again: its
   *    *presence* switches it from the default `True` to `== 'true'`, so `?paginate=` (empty)
   *    means **false** and a bare absent key means true.
   *  * ⚠️ **`int()` runs unguarded on both `state` and `page`**, so `?page=` and `?state=abc`
   *    are **500**s, not 400s. {@link pythonInt} reproduces `int(str)` **on the axes its own
   *    docblock enumerates** — the whitespace set (**C63**), the non-ASCII decimal-digit fold
   *    and PEP 515's underscores (**B1**) — and deliberately claims no more than that;
   *    `Number()` would accept and reject different strings on all three.
   *  * ⚠️ **The defaults are Python `int`s, not strings** — `get('state', 0)`, `get('page', 1)`
   *    — where `LoanView.get` writes `get('page', '1')`. `int(0)` and `int('0')` agree, so
   *    the two spellings are observably identical; noted because the difference invites a
   *    "consistency" edit that would change nothing and cost a review round.
   *  * ⚠️ **The page check is `page <= 0` while the message says "greater or equal than 0"**.
   *    The message contradicts the check — page 0 is rejected — and is copied **verbatim**,
   *    because a client may be matching on the text. Registered in
   *    `docs/phase-6-deviations.md`; the identical wrong message is in `LoanView.get`.
   *  * ⚠️ **Order of the two 400s matters**: `?page=0&state=9` yields the *page* message.
   *  * ⚠️ A repeated `?page=1&page=2` is `QueryDict.get`, i.e. the **last** value.
   *
   * `state` defaults to `0 ACTIVE`, so the **default list is the open CAPs only**.
   */
  @Get()
  @HttpCode(HttpStatus.OK)
  async list(
    @CurrentUser() actor: AuthenticatedUser,
    @Query('all_accounts') allAccountsRaw?: string | string[],
    @Query('state') stateRaw?: string | string[],
    @Query('page') pageRaw?: string | string[],
    @Query('paginate') paginateRaw?: string | string[],
  ): Promise<PageEnvelope<SavingAccountDto> | UnpaginatedEnvelope<SavingAccountDto>> {
    const allAccounts = lastQueryValue(allAccountsRaw) === 'true';
    const state = pythonInt(lastQueryValue(stateRaw) ?? '0');
    const page = pythonInt(lastQueryValue(pageRaw) ?? '1');

    const paginateValue = lastQueryValue(paginateRaw);
    const paginate = paginateValue === undefined ? true : paginateValue === 'true';

    if (page <= 0) {
      throw ApiException.withMessage(
        HttpStatus.BAD_REQUEST,
        'Page number must be greater or equal than 0',
      );
    }
    if (state > 1 || state < 0) {
      throw ApiException.withMessage(HttpStatus.BAD_REQUEST, 'State must be between 0 and 1');
    }

    // `if user.role <= 2:` — the profile is already resolved by the guard, and a caller with
    // no profile row cannot get past it (default deny).
    const role = actor.profile?.role;
    const privileged = role !== undefined && role <= Role.TREASURER;

    return this.accounts.getAccounts(actor.id, page, privileged && allAccounts, state, paginate);
  }

  /**
   * `SavingAccountView.put`.
   *
   * ```python
   * result = saving_account_service.update_account(request.data)
   * if result:
   *     return Response(status=status.HTTP_201_CREATED)
   * return Response(status=status.HTTP_404_NOT_FOUND)
   * ```
   *
   * ⚠️ **201 Created for an update, and both responses are bodiless.** DRF renders
   * `Response(status=...)` as a **zero-byte** body — not `null`, not `{}` — so a successful
   * revalue is `201` with `Content-Length: 0`. Odd, and it is the contract.
   *
   * ⚠️ **404 is the only "not found" here, and it is narrow.** It is returned *only* when the
   * body is well-formed and names a row that does not exist. A body missing `id`, `state` or
   * `value` is a `KeyError` → **500**, and a non-numeric `id` is a `ValueError` out of
   * Django's field coercion → **500** as well.
   *
   * `value` is the **new total balance**, a replacement rather than a deposit (**Q21**), and
   * the write sends **no notification** (**Q22**).
   */
  @Put()
  async update(@Body() body: unknown): Promise<never> {
    const updated = await this.accounts.updateAccount(body);
    throw ApiException.empty(updated ? HttpStatus.CREATED : HttpStatus.NOT_FOUND);
  }

  /**
   * Keeps the unimplemented methods inside the guarded pipeline, so they 403 as in v1 rather
   * than 404ing in Nest's router (plan §4 rule 12).
   *
   * ⚠️ Unreachable in practice on a guarded DRF view: `APIView.initial()` checks permissions
   * **before** `dispatch` resolves a handler, so every method absent from
   * `list_permissions['SavingAccountView']` — `PATCH`, `DELETE`, `OPTIONS` — is denied there,
   * for every role including ADMIN. The route exists to give `RolesGuard` something to guard.
   */
  @DrfNoRequestData()
  @All()
  methodNotAllowed(@Req() request: Request): never {
    throw DrfException.methodNotAllowed(request.method, 'GET, POST, PUT, HEAD, OPTIONS');
  }
}
