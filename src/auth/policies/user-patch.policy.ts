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
 * v1's behavior and Phase 3 owns the decision of whether to keep it; the policy below is
 * indexed by resolved section, so it is unaffected either way.
 */
export type UserSection = 'personal' | 'finance' | 'preferences';

/**
 * The only field in the `personal` section that is not universally self-writable.
 * `__update_user_personal` writes `user.role = obj['role']` unconditionally — this is the
 * privilege-escalation path §5 D1 closes.
 */
export const ROLE_FIELD = 'role';

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
   * The fields the caller is attempting to write.
   *
   * ⚠️ **Phase 3 must decide how this set is computed and say so in its deviation note.**
   * v1's client sends the whole `personal` object on every PATCH, `role` included, so
   * "every key present in the body" would 403 a member editing their own phone number.
   * "Only keys whose value differs from the stored row" keeps existing clients working.
   * {@link changedFields} implements the second reading; the policy itself is agnostic.
   */
  readonly fields: readonly string[];
}

/** The roles that may write the `finance` section, on their own row or anyone else's. */
const PRIVILEGED_FINANCE_ROLES: readonly Role[] = [Role.ADMIN, Role.TREASURER];

/**
 * Decides whether `actor` may write `fields` of `section` on `targetUserId`.
 * Throws DRF's `403 {"detail": "You do not have permission to perform this action."}`
 * — the same body `APIRolePermission` produces — on any violation.
 */
export function assertUserPatchAllowed(attempt: UserPatchAttempt): void {
  const allowlist = userPatchAllowlist(attempt);
  allowlist.assert(attempt.fields);
}

/**
 * The allowlist for a given caller/target/section, exposed separately so Phase 3 can also
 * use it to build responses and so the table above can be tested exhaustively.
 *
 * `WRITABLE.<section>` is the set of non-`role` fields; the policy does not enumerate the
 * concrete personal/finance/preference column names, because those belong to Phase 3's DTOs
 * and duplicating them here would create two lists to keep in sync. Instead a permitted
 * section yields an allowlist that accepts everything *except* the fields this module
 * explicitly restricts.
 */
export function userPatchAllowlist(attempt: UserPatchAttempt): FieldAllowlist {
  const role = attempt.actor.profile?.role;
  if (role === undefined) {
    // No `fondo_api_userprofile` row: same default-deny as `APIRolePermission`.
    return FieldAllowlist.none();
  }

  const own = isSelf(attempt.actor, attempt.targetUserId);

  if (attempt.section === 'finance') {
    // Privileged section: ownership is irrelevant in both directions.
    return PRIVILEGED_FINANCE_ROLES.includes(role)
      ? FieldAllowlist.from(attempt.fields)
      : FieldAllowlist.none();
  }

  // `personal` / `preferences`: self-service for everyone, plus ADMIN acting on anyone.
  if (!own && role !== Role.ADMIN) {
    return FieldAllowlist.none();
  }

  const permitted = attempt.fields.filter((field) => field !== ROLE_FIELD || role === Role.ADMIN);
  return FieldAllowlist.from(permitted);
}

/**
 * The fields of `submitted` whose value differs from `stored`, using `Object.is` on the
 * primitive values v1's user payloads carry (strings, numbers, booleans, `null`).
 *
 * Offered for the "tolerate an unchanged `role` key" reading of {@link UserPatchAttempt.fields}.
 * It is **not** applied automatically — Phase 3 chooses.
 */
export function changedFields(
  submitted: Readonly<Record<string, unknown>>,
  stored: Readonly<Record<string, unknown>>,
): string[] {
  return Object.keys(submitted).filter((key) => !Object.is(submitted[key], stored[key]));
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
