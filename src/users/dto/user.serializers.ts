import { formatDateEs } from '../../common/i18n/spanish-format';
import { formatDrfDateField, fromDateColumn } from '../../common/utils/date.util';

/**
 * `fondo_api/serializers.py` — the six serializers `views/user.py` renders through, ported
 * as plain functions.
 *
 * ## Two DRF properties that are part of the wire format
 *
 * 1. **Key order is `Meta.fields` order.** `ModelSerializer.get_fields` walks the declared
 *    `fields` tuple and builds an `OrderedDict`, and `JSONRenderer` does not sort. So
 *    `UserProfileSerializer` emits `full_name` first and `birthdate` last, regardless of
 *    where the columns sit in the table. Object literals below are written in that order and
 *    must stay in it.
 * 2. **`SerializerMethodField`s are computed, not stored** — `full_name`, `role_display`,
 *    `last_modified`, `total_savingaccounts`, `requester`, `requestee`.
 *
 * ## Types
 *
 * `identification` is `BigIntegerField` → DRF `IntegerField` → a bare JSON **number**. v2
 * carries it as a `bigint` and the global `json replacer` (plan rule 5b) renders it as a
 * number, so it is passed through rather than converted here.
 */

/** `UserProfile.ROLES`, in `get_role_display()` form. */
export const ROLE_DISPLAY: Readonly<Record<number, string>> = Object.freeze({
  0: 'ADMIN',
  1: 'PRESIDENT',
  2: 'TREASURER',
  3: 'MEMBER',
});

/** The two physical halves of `UserProfile(User)` as every read in this module loads them. */
export interface UserProfileRow {
  readonly user_ptr_id: number;
  readonly identification: bigint;
  readonly role: number;
  readonly birthdate: Date | null;
  readonly auth_user: {
    readonly email: string;
    readonly first_name: string;
    readonly last_name: string;
  };
}

export interface UserFinanceRow {
  readonly contributions: bigint;
  readonly balance_contributions: bigint;
  readonly total_quota: bigint;
  readonly available_quota: bigint;
  readonly utilized_quota: bigint;
  readonly last_modified: Date;
}

export interface UserPreferenceRow {
  readonly notifications: boolean;
  readonly primary_color: string;
  readonly secondary_color: string;
}

export interface UserProfileDto {
  full_name: string;
  identification: bigint;
  email: string;
  role_display: string;
  id: number;
  first_name: string;
  last_name: string;
  role: number;
  birthdate: string | null;
}

/**
 * `UserProfileSerializer`.
 *
 * ```python
 * fields = ('full_name', 'identification','email','role_display','id',
 *           'first_name', 'last_name', 'role', 'birthdate')
 * ```
 *
 * `role_display` is `serializers.CharField(source='get_role_display')`, i.e. the label from
 * `UserProfile.ROLES`. ⚠️ An out-of-range role would make `get_role_display()` return the
 * **raw value as a string** in Django (`_get_FIELD_display` falls back to `str(value)`), so
 * that is reproduced rather than throwing — the column has no CHECK constraint.
 */
export function serializeUserProfile(user: UserProfileRow): UserProfileDto {
  return {
    full_name: `${user.auth_user.first_name} ${user.auth_user.last_name}`,
    identification: user.identification,
    email: user.auth_user.email,
    role_display: ROLE_DISPLAY[user.role] ?? String(user.role),
    id: user.user_ptr_id,
    first_name: user.auth_user.first_name,
    last_name: user.auth_user.last_name,
    role: user.role,
    birthdate: formatDrfDateField(user.birthdate),
  };
}

export interface UserFinanceDto {
  contributions: bigint;
  balance_contributions: bigint;
  total_quota: bigint;
  available_quota: bigint;
  last_modified: string;
  utilized_quota: bigint;
  total_savingaccounts: bigint;
}

/**
 * `UserFinanceSerializer`.
 *
 * ⚠️ **`last_modified` is `format_date(obj.last_modified, locale='es')` with *no*
 * `timezone.localtime` call** (`serializers.py:29-30`) — unlike `LoanSerializer.get_created_at`
 * (`:88-90`), which converts first. That is not an oversight to tidy up: `last_modified` is a
 * `DateField`, so there is no instant to convert, while `created_at` is a `timestamptz`.
 * Plan rule 5c makes the difference a compile-time one — {@link fromDateColumn} is the only
 * conversion that type-checks here.
 *
 * `total_savingaccounts` is `sum(acc.value for acc in SavingAccount.objects.filter(user_id=…,
 * state=0))`; Python's `sum([])` is `0`, so an empty result is `0` and not `null`.
 */
export function serializeUserFinance(
  finance: UserFinanceRow,
  totalSavingAccounts: bigint,
): UserFinanceDto {
  return {
    contributions: finance.contributions,
    balance_contributions: finance.balance_contributions,
    total_quota: finance.total_quota,
    available_quota: finance.available_quota,
    last_modified: formatDateEs(fromDateColumn(finance.last_modified)),
    utilized_quota: finance.utilized_quota,
    total_savingaccounts: totalSavingAccounts,
  };
}

export interface UserPreferenceDto {
  notifications: boolean;
  primary_color: string;
  secondary_color: string;
}

/** `UserPreferenceSerializer`. */
export function serializeUserPreference(preference: UserPreferenceRow): UserPreferenceDto {
  return {
    notifications: preference.notifications,
    primary_color: preference.primary_color,
    secondary_color: preference.secondary_color,
  };
}

export interface UserFullInfoDto {
  user: UserProfileDto;
  finance: UserFinanceDto;
  preferences: UserPreferenceDto;
}

/**
 * `UserFullInfoSerializer`.
 *
 * ⚠️ It extends `serializers.Serializer`, **not** `ModelSerializer`, so its `Meta.fields =
 * ('user', 'finance')` is inert: a plain `Serializer` takes its field set from the declared
 * attributes. All **three** method fields are emitted, in declaration order —
 * `user`, `finance`, `preferences`. Reading `Meta` and omitting `preferences` would drop the
 * member's theme colours and notification flag from every profile load.
 */
export function serializeUserFullInfo(
  user: UserProfileRow,
  finance: UserFinanceRow,
  totalSavingAccounts: bigint,
  preference: UserPreferenceRow,
): UserFullInfoDto {
  return {
    user: serializeUserProfile(user),
    finance: serializeUserFinance(finance, totalSavingAccounts),
    preferences: serializeUserPreference(preference),
  };
}

export interface UserBirthdateDto {
  birthdate: string | null;
  full_name: string;
}

/** `UserBirthdateSerializer` — `fields = ('birthdate', 'full_name')`, in that order. */
export function serializeUserBirthdate(user: UserProfileRow): UserBirthdateDto {
  return {
    birthdate: formatDrfDateField(user.birthdate),
    full_name: `${user.auth_user.first_name} ${user.auth_user.last_name}`,
  };
}

export interface PowerRow {
  readonly id: number;
  readonly state: number;
  readonly meeting_date: Date;
  readonly requestee: { readonly auth_user: { first_name: string; last_name: string } };
  readonly requester: { readonly auth_user: { first_name: string; last_name: string } };
}

export interface PowerDto {
  id: number;
  state: number;
  meeting_date: string;
  requestee: string;
  requester: string;
}

/**
 * `PowerSerializer` — `fields = ('id', 'state', 'meeting_date', 'requestee', 'requester')`.
 *
 * ⚠️ `meeting_date` is rendered by DRF's `DateField`, i.e. **ISO `YYYY-MM-DD`** — *not*
 * `format_date(..., locale='es')`. Only the four dates that go through an explicit
 * `SerializerMethodField` are Spanish-formatted; this one is not, and the power-of-attorney
 * *email* formats the same value the other way (`services/user.py:203`). Both spellings of the
 * same date are correct, in different places.
 */
export function serializePower(power: PowerRow): PowerDto {
  return {
    id: power.id,
    state: power.state,
    meeting_date: formatDrfDateField(power.meeting_date) as string,
    requestee: `${power.requestee.auth_user.first_name} ${power.requestee.auth_user.last_name}`,
    requester: `${power.requester.auth_user.first_name} ${power.requester.auth_user.last_name}`,
  };
}
