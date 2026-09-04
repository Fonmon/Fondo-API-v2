import {
  All,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { V1View } from '../auth/decorators/v1-view.decorator';
import { ApiException } from '../common/http/api.exception';
import { lastQueryValue } from '../common/http/django-query';
import { assertRequestDataParsable, DrfNoRequestData } from '../common/http/drf-parser.interceptor';
import { DrfException } from '../common/http/drf.exception';
import { ActivityService } from './activity.service';
import { parseActivityPathId } from './activity-path-id';
import type { ActivityDetailDto } from './dto/activity.serializers';

/**
 * `fondo_api/views/activity.py:ActivityDetailView`, mounted by
 * `url(r'^api/activity/(?P<id>[0-9]+)/?$', …, name='view_activity_detail')`.
 *
 * ⚠️ **This is the one detail route in all of v1 that accepts a trailing slash.** Every other
 * `(?P<id>[0-9]+)` pattern — loans, users, files, activity *years* — ends `)$`, so `/5/`
 * 404s there and resolves here. It is not a rule, it is v1's inconsistency, and
 * `django-url-conf.ts` transcribes it rather than summarising it (`docs/adding-a-route.md`
 * §1, finding S7).
 *
 * `list_permissions['ActivityDetailView']` is `GET 3`, `PATCH 1`, `DELETE 1`. Both writes are
 * ADMIN (0) and PRESIDENT (1) only — **a TREASURER cannot touch activities.**
 */
@V1View('ActivityDetailView')
@Controller('api/activity')
export class ActivityDetailController {
  constructor(private readonly activities: ActivityService) {}

  /**
   * `ActivityDetailView.get`.
   *
   * ```python
   * activity = activity_service.get_activity(id)
   * if activity is None:
   *     return Response(status=status.HTTP_404_NOT_FOUND)
   * return Response(activity, status=status.HTTP_200_OK)
   * ```
   *
   * The 404 carries a **zero-byte** body — no `{"message": …}`, no `{"detail": …}`.
   *
   * ⚠️ **No ownership check and none added.** `ActivityDetailSerializer` nests the full
   * `UserProfileSerializer` for every attached member, so any authenticated member (`GET 3`)
   * reads every other member's `identification`, `email` and `birthdate` from this route.
   * That is v1's behaviour; unlike loans (**D10**) and users (**D25**), no restriction is
   * introduced here — Phase 5 owns no §5 rows and the plan has none pre-declared for it. It
   * is registered as a **finding** for `business-analyst` in `docs/phase-5-deviations.md` §3,
   * not silently changed.
   */
  @Get(':id')
  @HttpCode(HttpStatus.OK)
  async read(@Param('id') rawId: string): Promise<ActivityDetailDto> {
    const activity = await this.activities.getActivity(parseActivityPathId(rawId));
    if (activity === null) {
      throw ApiException.empty(HttpStatus.NOT_FOUND);
    }
    return activity;
  }

  /**
   * `ActivityDetailView.patch`.
   *
   * ```python
   * patch = request.query_params.get('patch','activity')
   * if patch != 'activity' and patch != 'user':
   *     return Response(status=status.HTTP_400_BAD_REQUEST)
   * activity = activity_service.patch_activity(patch, id, request.data)
   * if activity is None:
   *     return Response(status=status.HTTP_404_NOT_FOUND)
   * return Response(activity, status=status.HTTP_200_OK)
   * ```
   *
   * ⚠️ `request.query_params` is a `QueryDict`, so `?patch=user&patch=activity` takes the
   * **last** value — {@link lastQueryValue}, plan §8. `?patch=` (present but empty) is `''`,
   * which is neither, and therefore a **400**.
   *
   * ⚠️ **The 400 is the only 400 on this route.** Everything downstream of the `patch` check
   * runs inside `patch_activity`'s bare `except:`, so a missing body key, a bad `state`, an
   * unknown activity and an unknown `ActivityUser` are all the same **404** with a zero-byte
   * body. Do not narrow that into a 400 or let a 500 escape.
   *
   * ⚠️ The 400 branch returns **before** `request.data` is touched, so a `?patch=nope` with a
   * `text/plain` body is a 400 in v1 and not a 415 — but a valid `patch=` with the same body
   * *is* a 415. One handler, two parser outcomes, which is why the marker cannot go on the
   * method: {@link ApiException} is raised first and the body is only read after.
   */
  @DrfNoRequestData()
  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  async update(
    @Param('id') rawId: string,
    @Query('patch') rawPatch: string | string[] | undefined,
    @Req() request: Request,
  ): Promise<ActivityDetailDto> {
    const patch = lastQueryValue(rawPatch) ?? 'activity';
    if (patch !== 'activity' && patch !== 'user') {
      throw ApiException.empty(HttpStatus.BAD_REQUEST);
    }
    // Only now does v1 reach `request.data`, so only now can it 415 / 400 on the parser.
    assertRequestDataParsable(request);
    const activity = await this.activities.patchActivity(
      patch,
      parseActivityPathId(rawId),
      request.body,
    );
    if (activity === null) {
      throw ApiException.empty(HttpStatus.NOT_FOUND);
    }
    return activity;
  }

  /**
   * `ActivityDetailView.delete`.
   *
   * ```python
   * activity_service.remove_activity(id)
   * return Response(status=status.HTTP_200_OK)
   * ```
   *
   * ⚠️ **200 with a zero-byte body, unconditionally** — including for an id that never
   * existed. `remove_activity` is `filter(id = id).delete()` with no existence check, so the
   * response cannot be used to learn whether the activity was there.
   *
   * ⚠️ `200`, not `204`: v1 chose `HTTP_200_OK`, and plan §4 rule 2 forbids modernising it.
   */
  @DrfNoRequestData()
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  async remove(@Param('id') rawId: string): Promise<void> {
    await this.activities.removeActivity(parseActivityPathId(rawId));
  }

  /** See `ActivityYearController.methodNotAllowed` — the route exists so the guard can run. */
  @DrfNoRequestData()
  @All(':id')
  methodNotAllowed(@Req() request: Request): never {
    throw DrfException.methodNotAllowed(request.method, 'GET, PATCH, DELETE, HEAD, OPTIONS');
  }
}
