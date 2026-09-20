import { All, Controller, Get, HttpStatus, Post, Req, Res } from '@nestjs/common';
import type { Request, Response as ExpressResponse } from 'express';
import { V1View } from '../auth/decorators/v1-view.decorator';
import { DrfNoRequestData } from '../common/http/drf-parser.interceptor';
import { DrfException } from '../common/http/drf.exception';
import { sendDrfBody } from '../common/http/drf-response';
import { ActivityService } from './activity.service';

/**
 * `fondo_api/views/activity.py:ActivityYearView`, mounted by
 * `url(r'^api/activity/year/?$', …, name='view_activity_year')` — trailing slash **optional**,
 * so `/api/activity/year/` resolves too (`docs/adding-a-route.md` §1).
 *
 * `list_permissions['ActivityYearView']` is `GET 3`, `POST 1`. The rule is a **ceiling**, so
 * the write is ADMIN (0) and PRESIDENT (1) only: a TREASURER (2) cannot create a year. This
 * is the phase where the PRESIDENT has a domain of their own — operator Q23/Q25 kept them out
 * of saving accounts and out of `PATCH /api/user`.
 *
 * ⚠️ This controller is registered **before** {@link ActivityDetailController} in
 * {@link ActivityModule}, because `/api/activity/year` also matches Express's
 * `api/activity/:id`. Django never has that ambiguity — `^api/activity/(?P<id>[0-9]+)/?$`
 * cannot match `year`. Condition **C20** is the backstop: if the order were wrong,
 * `RolesGuard` would find the URL table resolving `ActivityYearView` against a controller
 * declaring `ActivityDetailView` and raise a **500**, not a plausible 403. Pinned by an e2e
 * cell.
 */
@V1View('ActivityYearView')
@Controller('api/activity/year')
export class ActivityYearController {
  constructor(private readonly activities: ActivityService) {}

  /**
   * `ActivityYearView.get`.
   *
   * ```python
   * years = activity_service.get_years()
   * if len(years) == 0:
   *     return Response(status = status.HTTP_204_NO_CONTENT)
   * return Response(years, status=status.HTTP_200_OK)
   * ```
   *
   * ⚠️ **An empty table is `204 No Content`, not `200 []`.** DRF renders a zero-byte body and
   * `Response.rendered_content` then drops the `Content-Type` entirely. The one v1 test that
   * covers it — `test_get_years_empty` — asserts exactly this.
   */
  @Get()
  async list(@Res() response: ExpressResponse): Promise<void> {
    const years = await this.activities.getYears();
    if (years.length === 0) {
      sendDrfBody(response, HttpStatus.NO_CONTENT, undefined);
      return;
    }
    sendDrfBody(response, HttpStatus.OK, years);
  }

  /**
   * `ActivityYearView.post`.
   *
   * ```python
   * state = activity_service.create_year()
   * if state:
   *     return Response(status=status.HTTP_201_CREATED)
   * return Response(status=status.HTTP_304_NOT_MODIFIED)
   * ```
   *
   * ⚠️ **A bodiless `304 Not Modified` from a `POST`.** Unusual, and ported exactly: it is how
   * v1 reports "this year's row already exists". `test_create_year` asserts it on the second
   * call. Note the retry is not inert — `create_year` has no transaction, so its disable of
   * the highest *other* year has already committed by the time the insert collides
   * (`docs/phase-5-prework.md` §2).
   *
   * ⚠️ **{@link DrfNoRequestData} is required here** and was one of the two regressions that
   * produced condition **C10**: the handler never touches `request.data`, so DRF never
   * negotiates a parser and `POST /api/activity/year` with `Content-Type: text/plain` is a
   * **201** in v1. Without the marker the parser interceptor answers 415.
   */
  @DrfNoRequestData()
  @Post()
  async create(@Res() response: ExpressResponse): Promise<void> {
    const created = await this.activities.createYear();
    sendDrfBody(response, created ? HttpStatus.CREATED : HttpStatus.NOT_MODIFIED, undefined);
  }

  /**
   * The `@All()` fallback (plan §4 rule 12): Nest 404s where DRF 405s, so the route has to
   * exist for `RolesGuard` to reach it at all.
   *
   * ⚠️ In practice it is unreachable on this view. `list_permissions['ActivityYearView']`
   * declares only `GET` and `POST`, so `APIRolePermission`'s bare `except` denies every other
   * method — `PUT`, `DELETE` and `OPTIONS` included, for every role including ADMIN — inside
   * `APIView.initial()`, before `dispatch` could raise `MethodNotAllowed`.
   */
  @DrfNoRequestData()
  @All()
  methodNotAllowed(@Req() request: Request): never {
    throw DrfException.methodNotAllowed(request.method, 'GET, POST, HEAD, OPTIONS');
  }
}
