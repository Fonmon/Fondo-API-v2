import { formatDrfDateField } from '../../common/utils/date.util';
import {
  serializeUserProfile,
  type UserProfileDto,
  type UserProfileRow,
} from '../../users/dto/user.serializers';

/**
 * The four activity serializers of `fondo_api/serializers.py:113-138`, ported as plain
 * functions.
 *
 * ```python
 * class ActivityYearSerializer(serializers.ModelSerializer):
 *     class Meta: model = ActivityYear;  fields = ('id', 'year', 'enable')
 *
 * class ActivityGeneralSerializer(serializers.ModelSerializer):
 *     class Meta: model = Activity;     fields = ('id','name')
 *
 * class ActivityUserSerializer(serializers.ModelSerializer):
 *     user = UserProfileSerializer()
 *     class Meta: model = ActivityUser; fields = ('id','state','user')
 *
 * class ActivityDetailSerializer(serializers.ModelSerializer):
 *     users = serializers.SerializerMethodField()
 *     class Meta: model = Activity;     fields = ('id','name','date','value','users')
 *     def get_users(self, obj):
 *         return ActivityUserSerializer(obj.activityuser_set.order_by('user_id'), many=True).data
 * ```
 *
 * Three properties of DRF that are part of the wire format here:
 *
 * 1. **Key order is `Meta.fields` order** — `ModelSerializer.get_fields` walks the tuple into
 *    an `OrderedDict` and `JSONRenderer` does not sort. The object literals below are written
 *    in that order and must stay in it.
 * 2. **`year` and `value` are `BigIntegerField`s** → DRF `IntegerField` → a **bare JSON
 *    number**. They are carried as `bigint` and rendered by the global `json replacer`
 *    (plan rule **5b**); `String(...)`-ing them here would emit `"1000"` where v1 emits
 *    `1000`.
 * 3. ⚠️ **`date` is a plain `ModelSerializer` field, so it renders ISO `YYYY-MM-DD`** — *not*
 *    the Spanish `babel.dates.format_date` spelling used for `last_modified`, `created_at`,
 *    `payday_limit` and `from_date`. v1 is not uniform about this and the non-uniformity is
 *    the contract (plan rule **5c** governs `@db.Date` vs `timestamptz`, not the spelling).
 *    `test_activity_views.py:148` pins `'2020-11-07'`. See {@link formatDrfDateField}.
 */

export interface ActivityYearRow {
  readonly id: number;
  readonly year: bigint;
  readonly enable: boolean;
}

export interface ActivityYearDto {
  id: number;
  year: bigint;
  enable: boolean;
}

/**
 * `ActivityYearSerializer`.
 *
 * ⚠️ `enable` is echoed **verbatim** from the column. It is not recomputed from
 * `year === currentYear`: `fondo_api_activityyear` holds **two** enabled rows in production
 * (2026 and 2020 — see `docs/phase-5-prework.md` §1), nothing in v1 reads the flag, and any
 * v2 code that derives it would diverge on real data while passing against a tidy fixture.
 */
export function serializeActivityYear(year: ActivityYearRow): ActivityYearDto {
  return {
    id: year.id,
    year: year.year,
    enable: year.enable,
  };
}

export interface ActivityGeneralRow {
  readonly id: number;
  readonly name: string;
}

export interface ActivityGeneralDto {
  id: number;
  name: string;
}

/** `ActivityGeneralSerializer` — `('id','name')` and nothing else, not even the date it sorts by. */
export function serializeActivityGeneral(activity: ActivityGeneralRow): ActivityGeneralDto {
  return {
    id: activity.id,
    name: activity.name,
  };
}

export interface ActivityUserRow {
  readonly id: number;
  readonly state: number;
  readonly user: UserProfileRow;
}

export interface ActivityUserDto {
  id: number;
  state: number;
  user: UserProfileDto;
}

/**
 * `ActivityUserSerializer` — `id` is the **`ActivityUser`** row's id, not the member's.
 *
 * That is the id `PATCH /api/activity/<id>?patch=user` expects in its body
 * (`services/activity.py:84-85`), so mistaking it for `user.id` would make every payment
 * update address the wrong row.
 */
export function serializeActivityUser(row: ActivityUserRow): ActivityUserDto {
  return {
    id: row.id,
    state: row.state,
    user: serializeUserProfile(row.user),
  };
}

export interface ActivityDetailRow {
  readonly id: number;
  readonly name: string;
  readonly date: Date;
  readonly value: bigint;
  /** `obj.activityuser_set.order_by('user_id')` — ordered by the **service**, not here. */
  readonly users: readonly ActivityUserRow[];
}

export interface ActivityDetailDto {
  id: number;
  name: string;
  /** Never `null`: `Activity.date` is a non-null `DateField` (`models.py:81`). */
  date: string;
  value: bigint;
  users: ActivityUserDto[];
}

/**
 * `ActivityDetailSerializer`.
 *
 * `get_users` orders by **`user_id`**, not by the `ActivityUser` id and not by the member's
 * name. On an activity created through `POST /api/activity/year/<id>` the two orders coincide
 * (`__add_users` inserts in `order_by('id')` order), but they part company for any row added
 * later, so the ordering is carried explicitly in the query.
 */
export function serializeActivityDetail(activity: ActivityDetailRow): ActivityDetailDto {
  return {
    id: activity.id,
    name: activity.name,
    date: formatDrfDateField(activity.date) as string,
    value: activity.value,
    users: activity.users.map(serializeActivityUser),
  };
}
