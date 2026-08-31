import { DrfException } from '../../common/http/drf.exception';
import { Role } from '../permissions/roles';
import { FieldAllowlist } from './field-allowlist';
import { isSelf } from './ownership';
import type { AuthenticatedUser } from '../types/authenticated-user';

/**
 * `services/user.py:update_user` dispatches on `obj['type']`:
 *
 * ```python
 * if obj['type'] == 'personal':   return self.__update_user_personal(id, obj['personal'])
 * if obj['type'] == 'finance':    return self.__update_user_finance(id, None, obj['finance'])
 * return self.__update_user_preferences(id, obj['preferences'])
 * ```
 *
 * ⚠️ Note the fall-through: **any** unrecognised `type` is treated as `preferences`. That is
 * v1's behavior; {@link resolveSection} reproduces it, and Phase 3 owns the decision of
 * whether to keep it.
 */
export type UserSection = 'personal' | 'finance' | 'preferences';

/**
 * `update_user`'s dispatch, and **the whole of authorisation level 1** (§7 "C8 resolved",
 * rule 2).
 *
 * v1 applies exactly the section named by `type` and **ignores every other key in the body**.
 * Its client posts `personal` *and* `finance` in the same request every time
 * (`fondo_api/tests/test_user_views.py:49-113`), so authorising on "the body contains a
 * `finance` key" instead of on `body.type` would 403 every ordinary member profile save —
 * 14 of 15 users, on day one of cutover.
 *
 * Taking the section from this function rather than from the body's shape is what makes that
 * mistake unrepresentable: the policy is only ever handed the dispatched section.
 */
export function resolveSection(type: unknown): UserSection {
  if (type === 'personal') {
    return 'personal';
  }
  if (type === 'finance') {
    return 'finance';
  }
  // v1's fall-through: `return self.__update_user_preferences(...)` for anything else,
  // including a missing `type`.
  return 'preferences';
}

/**
 * The only field in the `personal` section that is not universally self-writable.
 * `__update_user_personal` writes `user.role = obj['role']` unconditionally — this is the
 * privilege-escalation path §5 D1 closes.
 */
export const ROLE_FIELD = 'role';

/** The field `__update_user_finance` joins the treasurer's monthly TSV on (D16 / Q26). */
export const IDENTIFICATION_FIELD = 'identification';

/**
 * The writable field set of each section, transcribed from `services/user.py`.
 *
 * ```python
 * # :223-241  __update_user_personal
 * user.first_name = obj['first_name']
 * user.last_name  = obj['last_name']
 * user.email      = obj['email']
 * user.username   = obj['email']          # <- D15: v2 does NOT write username
 * user.identification = obj['identification']
 * user.role       = obj['role']
 * if 'birthdate' in obj: user.birthdate = obj['birthdate']
 *
 * # :208-221  __update_user_preferences
 * notifications, primary_color, secondary_color
 *
 * # :243-261  __update_user_finance
 * contributions, balance_contributions, total_quota, utilized_quota
 * # available_quota is *derived* (total_quota - utilized_quota), never taken from the body
 * ```
 *
 * These sets are what makes {@link FieldAllowlist} genuinely positive (review finding S4):
 * the allowlist is built from **this** table intersected with the caller's rights, never
 * from the caller's own payload, so a field nobody thought about — `is_active`,
 * `key_activation`, `user_ptr_id`, `available_quota` — is rejected rather than accepted.
 *
 * ⚠️ `username` is deliberately absent: D15 stops v2 rewriting the login name from `email`.
 */
export const PERSONAL_FIELDS: ReadonlySet<string> = new Set([
  'first_name',
  'last_name',
  'email',
  IDENTIFICATION_FIELD,
  ROLE_FIELD,
  'birthdate',
]);

export const PREFERENCES_FIELDS: ReadonlySet<string> = new Set([
  'notifications',
  'primary_color',
  'secondary_color',
]);

export const FINANCE_FIELDS: ReadonlySet<string> = new Set([
  'contributions',
  'balance_contributions',
  'total_quota',
  'utilized_quota',
]);

export const SECTION_FIELDS: Readonly<Record<UserSection, ReadonlySet<string>>> = Object.freeze({
  personal: PERSONAL_FIELDS,
  preferences: PREFERENCES_FIELDS,
  finance: FINANCE_FIELDS,
});

/**
 * Fields that need a role beyond "may write this section at all", keyed by field name.
 *
 * `role` is ADMIN-only — the escalation D1 closes.
 *
 * ⏳ `identification` is **not** listed yet. D16 recommends making it ADMIN-only (it is the
 * join key of the treasurer's monthly TSV, and a miss is only logged —
 * `services/user.py:144` — so a member editing their own cédula silently freezes their own
 * contributions and quota), but that is **Q26, still open with the operator**. When it is
 * answered, add `[IDENTIFICATION_FIELD]: [Role.ADMIN]` (or `[Role.ADMIN, Role.TREASURER]`)
 * here — `userPatchAllowlist` takes the map as a parameter so both readings are already
 * tested.
 */
export const PRIVILEGED_FIELDS: Readonly<Record<string, readonly Role[]>> = Object.freeze({
  [ROLE_FIELD]: [Role.ADMIN],
});

/**
 * §5 D1 — `PATCH /api/user/<id>` authorisation. **Not wired to a route yet:** the endpoint
 * lands in Phase 3. This module is the decision, unit-tested, so Phase 3 implements it
 * rather than re-deriving it.
 *
 * | Role | Own profile | Other users | `role` field | `finance` section |
 * |---|---|---|---|---|
 * | 0 ADMIN | ✅ | ✅ any section | ✅ only ADMIN | ✅ any user |
 * | 1 PRESIDENT | ✅ personal + preferences | ❌ | ❌ | ❌ |
 * | 2 TREASURER | ✅ personal + preferences | finance only | ❌ | ✅ any user |
 * | 3 MEMBER | ✅ personal + preferences | ❌ | ❌ | ❌ |
 *
 * Read as two independent axes, which is how the table's "additive privileges" principle
 * (plan §5, Q25a) actually decomposes:
 *
 *  * **`finance`** is a privileged section, full stop: ADMIN and TREASURER may write it for
 *    *any* user including themselves; PRESIDENT and MEMBER may not write it **even on their
 *    own profile** — quota is set by the treasurer's monthly file (Q12), never self-served.
 *  * **`personal` and `preferences`** are self-service for every role, and ADMIN may
 *    additionally write them for anyone.
 *  * **`role`** is writable by ADMIN alone, on any user.
 *
 * Route-level access (`UserDetailView.PATCH: 3`) still comes from
 * `list_permissions` — every role reaches the endpoint, and this policy decides what happens
 * once inside. Keeping the matrix untouched is what makes the Phase 1 parity criterion
 * ("14 view classes × method × role → identical allow/deny") still hold: D1 changes
 * *sub-route* behavior only.
 */
export interface UserPatchAttempt {
  readonly actor: AuthenticatedUser;
  /** The resolved target user id (see `resolveUserId`), not the raw path segment. */
  readonly targetUserId: number;
  readonly section: UserSection;
  /**
   * The fields the caller is actually **changing** in {@link UserPatchAttempt.section}.
   *
   * ✅ **Decided** (§5 D1 clarification 1, §7 "C8 resolved" rule 3): this is
   * `changedFields(submitted, stored)`, not "every key present in the body". v1's client
   * echoes the whole `personal` object back on every PATCH, `role` included, so a presence
   * check would 403 every save by all 14 non-admin members.
   *
   * It gates **fields within** the section only. Whether the caller may write the section at
   * all is decided from `body.type` and never from this set — see
   * {@link assertUserPatchAllowed}.
   */
  readonly fields: readonly string[];
}

/** The roles that may write the `finance` section, on their own row or anyone else's. */
const PRIVILEGED_FINANCE_ROLES: readonly Role[] = [Role.ADMIN, Role.TREASURER];

/**
 * Decides whether `actor` may write `fields` of `section` on `targetUserId`.
 * Throws DRF's `403 {"detail": "You do not have permission to perform this action."}`
 * — the same body `APIRolePermission` produces — on any violation.
 *
 * ## Two levels, in this order (§7 "C8 resolved")
 *
 * 1. **The section gate.** `assertSectionWritable` decides "may this caller touch this
 *    section at all", from `body.type` + role + ownership. It does not look at any field, so
 *    a declared `finance` write by a MEMBER is a **403 whether the finance object is empty,
 *    unchanged, or absent**. This is the authoritative control, and it is the reason C7's
 *    empty-allowlist rule is defence in depth rather than the mechanism.
 * 2. **The field gate.** The allowlist — the section's fields (from `services/user.py`)
 *    intersected with the caller's rights — is asserted against the fields actually being
 *    changed. It rejects unknown fields (C6) and privileged ones: `role` always,
 *    `identification` once Q26 is answered (D16). **403 only on a real change**, because
 *    `attempt.fields` is expected to come from {@link changedFields}: v1's client echoes back
 *    the whole `personal` object, `role` included, so a presence check would 403 every save.
 *
 * A section the caller did **not** declare never reaches either level — see
 * {@link resolveSection}.
 */
export function assertUserPatchAllowed(attempt: UserPatchAttempt): void {
  // Level 1 — independent of `fields`, so an empty or unchanged section still 403s.
  assertSectionWritable(attempt.actor, attempt.targetUserId, attempt.section);
  // Level 2 — what may be changed inside a section the caller may write.
  userPatchAllowlist(attempt).assert(attempt.fields);
}

/**
 * The fields `attempt.actor` may write in `attempt.section` of `attempt.targetUserId`.
 *
 * ⚠️ **Independent of `attempt.fields`** — that is the fix for review finding S4. The
 * previous version returned `FieldAllowlist.from(attempt.fields)`, i.e. the caller's own
 * payload, which made the "positive allowlist" a tautology: it could reject `role` and whole
 * sections, but a field nobody thought about (`is_active`, `key_activation`, `user_ptr_id`)
 * was *accepted*. The set now comes from {@link SECTION_FIELDS}, transcribed from
 * `services/user.py`, intersected with the caller's rights.
 *
 * @param privileged fields needing a role beyond section access. Defaults to
 *   {@link PRIVILEGED_FIELDS}; parameterised so D16 (`identification`, Q26) can be switched
 *   on without touching this function.
 */
export function userPatchAllowlist(
  attempt: UserPatchAttempt,
  privileged: Readonly<Record<string, readonly Role[]>> = PRIVILEGED_FIELDS,
): FieldAllowlist {
  const role = attempt.actor.profile?.role;
  // No `fondo_api_userprofile` row: same default-deny as `APIRolePermission`.
  if (role === undefined) {
    return FieldAllowlist.none();
  }
  // Section access is decided in exactly one place; see `canWriteSection`.
  if (!canWriteSection(attempt.actor, attempt.targetUserId, attempt.section)) {
    return FieldAllowlist.none();
  }

  const writable = [...SECTION_FIELDS[attempt.section]].filter((field) => {
    const requiredRoles = privileged[field];
    return requiredRoles === undefined || requiredRoles.includes(role);
  });
  return FieldAllowlist.from(writable);
}

/**
 * The fields of `submitted` whose value differs from `stored`.
 *
 * This is the reading §5 D1 clarification 1 decided: the `role` check compares **values**, it
 * does not check presence. v1's client echoes the whole `personal` object back from
 * `GET /api/user/<id>` — `role` included — so a presence check would 403 every save by all
 * 14 non-admin members.
 *
 * ⚠️ **Comparison is type-normalised**, because the two sides come from different places and
 * `Object.is` would call every one of these a change (reviewer §4.1):
 *
 * | Field | Submitted (JSON body) | Stored (Prisma row) |
 * |---|---|---|
 * | `identification` | `1098765432` or `"1098765432"` | `1098765432n` (BigInt) |
 * | `role` | `3` or `"3"` | `3` |
 * | `birthdate` | `"1990-05-03"` | `Date` at UTC midnight (`@db.Date`) |
 *
 * Phantom "changes" here are not cosmetic: under the rule above they turn into 403s on
 * ordinary saves, which is exactly the failure D1 clarification 1 exists to prevent.
 */
export function changedFields(
  submitted: Readonly<Record<string, unknown>>,
  stored: Readonly<Record<string, unknown>>,
): string[] {
  return Object.keys(submitted).filter((key) => !valuesMatch(submitted[key], stored[key]));
}

/** True when the two values are the same after normalising across the JSON/Prisma boundary. */
function valuesMatch(submitted: unknown, stored: unknown): boolean {
  if (Object.is(submitted, stored)) {
    return true;
  }
  // `null` and `undefined` are the same absence as far as a PATCH body is concerned.
  if (submitted == null || stored == null) {
    return submitted == null && stored == null;
  }
  return normalise(submitted) === normalise(stored);
}

/** A comparable string form: BigInt/number/numeric-string collapse, `Date` becomes a date. */
function normalise(value: unknown): string {
  if (value instanceof Date) {
    // `@db.Date` columns come back as UTC midnight; the body sends 'YYYY-MM-DD'.
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === 'bigint' || typeof value === 'number') {
    return value.toString();
  }
  if (typeof value === 'string') {
    // A numeric string compares equal to the number it denotes ("3" vs 3), which is what a
    // form-encoded or loosely-typed client sends. A date string is left alone and matches
    // the `Date` branch above.
    const asNumber = Number(value);
    return value.trim() !== '' && Number.isFinite(asNumber) ? asNumber.toString() : value;
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  return JSON.stringify(value) ?? String(value);
}

/**
 * Convenience for callers that only need the section-level answer (e.g. deciding whether to
 * even load the target row). Equivalent to "the allowlist is not empty for a non-empty
 * write".
 */
export function canWriteSection(
  actor: AuthenticatedUser,
  targetUserId: number,
  section: UserSection,
): boolean {
  const role = actor.profile?.role;
  if (role === undefined) {
    return false;
  }
  if (section === 'finance') {
    return PRIVILEGED_FINANCE_ROLES.includes(role);
  }
  return isSelf(actor, targetUserId) || role === Role.ADMIN;
}

/** Throws unless {@link canWriteSection} allows the write. */
export function assertSectionWritable(
  actor: AuthenticatedUser,
  targetUserId: number,
  section: UserSection,
): void {
  if (!canWriteSection(actor, targetUserId, section)) {
    throw DrfException.permissionDenied();
  }
}
