import { All, Controller, Get, HttpStatus, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { V1View } from '../auth/decorators/v1-view.decorator';
import type { AuthenticatedUser } from '../auth/types/authenticated-user';
import { ApiException } from '../common/http/api.exception';
import { lastQueryValue } from '../common/http/django-query';
import { DrfNoRequestData } from '../common/http/drf-parser.interceptor';
import { DrfException } from '../common/http/drf.exception';
import { AdminService } from './admin.service';

/**
 * `fondo_api/views/admin.py:AdminView`, mounted by `url(r'^api/admin/?$', …)` — trailing
 * slash optional. `list_permissions['AdminView']` is `GET 0`: ADMIN only.
 *
 * ⚠️ **v1 has no test for this view.** The cells in `test/admin.e2e-spec.ts` are written from
 * the source below and from the pinned v1, measured 2026-09-12.
 */
@V1View('AdminView')
@Controller('api/admin')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  /**
   * `AdminView.get`.
   *
   * ```python
   * type = request.query_params.get('type', None)
   * if type == 'email':         admin_service.test_email(request.user)
   * if type == 'notifications': admin_service.test_notifications(request.user)
   * if type == None:            return Response(status=status.HTTP_400_BAD_REQUEST)
   * return Response(status=status.HTTP_200_OK)
   * ```
   *
   * ⚠️ **Only a missing `type` is a 400.** Every other value — `''`, a bare `?type`, `EMAIL`,
   * `push` — is **200 and sends nothing**. The comparison is exact and case-sensitive, and a
   * repeated key is `QueryDict.get`, i.e. the **last** value: `?type=email&type=x` sends
   * nothing, `?type=x&type=email` sends the mail. All measured on v1.
   *
   * Bodiless on both branches.
   */
  @Get()
  async selfTest(
    @CurrentUser() actor: AuthenticatedUser,
    @Query('type') typeRaw?: string | string[],
  ): Promise<never> {
    const type = lastQueryValue(typeRaw);
    if (type === 'email') {
      await this.admin.testEmail(actor);
    }
    if (type === 'notifications') {
      await this.admin.testNotifications(actor);
    }
    if (type === undefined) {
      throw ApiException.empty(HttpStatus.BAD_REQUEST);
    }
    throw ApiException.empty(HttpStatus.OK);
  }

  /** See `LoanController.methodNotAllowed` — the route exists so the guard can run. */
  @DrfNoRequestData()
  @All()
  methodNotAllowed(@Req() request: Request): never {
    throw DrfException.methodNotAllowed(request.method, 'GET, HEAD, OPTIONS');
  }
}
