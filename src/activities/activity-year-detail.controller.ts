import { All, Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { V1View } from '../auth/decorators/v1-view.decorator';
import { DrfNoRequestData } from '../common/http/drf-parser.interceptor';
import { DrfException } from '../common/http/drf.exception';
import { ActivityService } from './activity.service';
import { parseActivityPathId } from './activity-path-id';
import type { ActivityGeneralDto } from './dto/activity.serializers';

/**
 * `fondo_api/views/activity.py:ActivityYearDetailView`, mounted by
 * `url(r'^api/activity/year/(?P<id_year>[0-9]+)$', …, name='view_activity_year_detail')`.
 *
 * ⚠️ **No trailing `/?`** in v1's pattern, so `/api/activity/year/5/` is a **404** —
 * `DjangoUrlResolverMiddleware` enforces that before the guards. It is the sibling route,
 * `^api/activity/(?P<id>[0-9]+)/?$`, that is v1's lone detail-route exception
 * (`docs/adding-a-route.md` §1). Two routes in this one module, two different answers.
 *
 * `list_permissions['ActivityYearDetailView']` is `GET 3`, `POST 1` — the write is ADMIN and
 * PRESIDENT only.
 */
@V1View('ActivityYearDetailView')
@Controller('api/activity/year')
export class ActivityYearDetailController {
  constructor(private readonly activities: ActivityService) {}

  /**
   * `ActivityYearDetailView.get`.
   *
   * ```python
   * activities = activity_service.get_activities(id_year)
   * return Response(activities, status = status.HTTP_200_OK)
   * ```
   *
   * ⚠️ **Always 200**, never 404: nothing looks the year up, so an id that does not exist is
   * a `200 []`. `ActivityGeneralSerializer` emits `id` and `name` only — not the `date` the
   * list is ordered by, and not the value.
   */
  @Get(':idYear')
  @HttpCode(HttpStatus.OK)
  async list(@Param('idYear') rawIdYear: string): Promise<ActivityGeneralDto[]> {
    return this.activities.getActivities(parseActivityPathId(rawIdYear));
  }

  /**
   * `ActivityYearDetailView.post`.
   *
   * ```python
   * activity_service.create_activity(request.data, id_year)
   * return Response(status=status.HTTP_201_CREATED)
   * ```
   *
   * **201 with a zero-byte body**, and no validation of any kind on the way in: a missing
   * `name`, `value` or `date` is an uncaught `KeyError` → **500**, and an `id_year` that does
   * not exist is a deferred FK violation at `COMMIT` → **500**. See `ActivityService`.
   *
   * The write attaches one `ActivityUser` row per **active** member at state `0 NOT_PAID`.
   */
  @Post(':idYear')
  @HttpCode(HttpStatus.CREATED)
  async create(@Param('idYear') rawIdYear: string, @Body() body: unknown): Promise<void> {
    await this.activities.createActivity(body, parseActivityPathId(rawIdYear));
  }

  /** See `ActivityYearController.methodNotAllowed` — the route exists so the guard can run. */
  @DrfNoRequestData()
  @All(':idYear')
  methodNotAllowed(@Req() request: Request): never {
    throw DrfException.methodNotAllowed(request.method, 'GET, POST, HEAD, OPTIONS');
  }
}
