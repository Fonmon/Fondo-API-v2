import { formatDateEs } from '../../common/i18n/spanish-format';
import { fromDateColumn } from '../../common/utils/date.util';
import { toBogotaDate } from '../../common/utils/timezone.util';

/**
 * `fondo_api/serializers.py:SavingAccountSerializer` (`:161-179`), ported as a plain function
 * in the same shape as `src/loans/dto/loan.serializers.ts`.
 *
 * ```python
 * class SavingAccountSerializer(serializers.ModelSerializer):
 *     user_full_name = serializers.SerializerMethodField()
 *     created_at     = serializers.SerializerMethodField()
 *     end_date       = serializers.SerializerMethodField()
 *
 *     class Meta:
 *         model = SavingAccount
 *         fields = ('value','created_at','state','user_full_name','id','end_date',)
 *
 *     def get_user_full_name(self, obj):
 *         return '{} {}'.format(obj.user.first_name, obj.user.last_name)
 *
 *     def get_created_at(self, obj):
 *         created_at = timezone.localtime(obj.created_at)
 *         return format_date(created_at, locale=settings.LANGUAGE_LOCALE)
 *
 *     def get_end_date(self, obj):
 *         return format_date(obj.end_date, locale=settings.LANGUAGE_LOCALE)
 * ```
 *
 * ## ⚠️ Two date types, two conversions, in one serializer — plan rule **5c**, condition **C1**
 *
 * This is the **first place in v2 where both halves of the `PlainDate` split appear in a
 * single response object**, and the two lines above are three characters apart in v1:
 *
 * | field | column | v1 | v2 |
 * |---|---|---|---|
 * | `created_at` | `DateTimeField` → `timestamptz` | `format_date(timezone.localtime(obj.created_at))` | `formatDateEs(toBogotaDate(row.created_at))` |
 * | `end_date` | `DateField` → `date` | `format_date(obj.end_date)` — **no conversion at all** | `formatDateEs(fromDateColumn(row.end_date))` |
 *
 * Swapping them is invisible in CI and wrong in production. Reading `created_at` with
 * {@link fromDateColumn} renders the **next day's** date for every instant between 19:00 and
 * 23:59 Bogota — about 21% of every day, and every CAP created in a Colombian evening.
 * Reading `end_date` with {@link toBogotaDate} is worse in the other direction: Prisma hands
 * back a `@db.Date` as UTC midnight, so a Bogota conversion moves *every* row to the previous
 * day, unconditionally. `formatDateEs` only accepts a {@link PlainDate}, which is what forces
 * the choice to be spelled out here rather than defaulted.
 *
 * ## Both are Spanish, and that is not the general rule
 *
 * `SavingAccountSerializer` declares **both** dates as `SerializerMethodField`s calling
 * `babel.dates.format_date`, so both render `d MMM y` in `es` (`'28 feb. 2024'`). That is not
 * true of dates generally — `UserProfileSerializer.birthdate` and `ActivityDetailSerializer.date`
 * are plain `ModelSerializer` fields and come out ISO `YYYY-MM-DD` (see
 * {@link formatDrfDateField}). The spelling is per-field in v1 and is transcribed per-field
 * here.
 *
 * ## Key order is `Meta.fields` order
 *
 * `ModelSerializer.get_fields` walks the declared tuple into an `OrderedDict` and
 * `JSONRenderer` does not sort, so the wire order is `value, created_at, state,
 * user_full_name, id, end_date` — **not** column order, and not alphabetical. The object
 * literal below is written in that order and must stay in it.
 */

/** `SavingAccount.ACCOUNT_STATE` (`models.py:137-140`). */
export const SAVING_ACCOUNT_ACTIVE = 0;
export const SAVING_ACCOUNT_CLOSED = 1;

/** A `fondo_api_savingaccount` row joined to the two halves of its owner. */
export interface SavingAccountRow {
  readonly id: number;
  readonly created_at: Date;
  readonly end_date: Date;
  readonly state: number;
  readonly value: bigint;
  readonly user_id: number;
  readonly user: {
    readonly auth_user: {
      readonly first_name: string;
      readonly last_name: string;
    };
  };
}

export interface SavingAccountDto {
  value: bigint;
  created_at: string;
  state: number;
  user_full_name: string;
  id: number;
  end_date: string;
}

/**
 * The Prisma `include` every read here needs. `user` is the `fondo_api_userprofile` half and
 * `auth_user` the `auth_user` half of Django's multi-table inheritance — `obj.user.first_name`
 * in v1 is a descriptor hop across the `user_ptr_id` join, not a column on the profile table.
 */
export const WITH_OWNER = {
  user: { select: { auth_user: { select: { first_name: true, last_name: true } } } },
} as const;

export function serializeSavingAccount(row: SavingAccountRow): SavingAccountDto {
  return {
    // `BigIntegerField` — rendered as a bare JSON number by the `json replacer`
    // (`JsonBigIntSetup`, plan rule 5b), exactly as Python's unbounded `int` is.
    value: row.value,
    // `timestamptz` → `timezone.localtime()` → Bogota calendar date. Rule 5c.
    created_at: formatDateEs(toBogotaDate(row.created_at)),
    state: row.state,
    user_full_name: `${row.user.auth_user.first_name} ${row.user.auth_user.last_name}`,
    id: row.id,
    // `DateField` → no conversion. Prisma hands `@db.Date` back at UTC midnight, so
    // `fromDateColumn` is the identity here and `toBogotaDate` would be off by a day. Rule 5c.
    end_date: formatDateEs(fromDateColumn(row.end_date)),
  };
}
