import { DrfException } from '../../common/http/drf.exception';
import type { AuthenticatedUser } from '../types/authenticated-user';

/**
 * v1's "me" sentinel. `fondo_api/urls.py` deliberately allows a negative id
 * (`(?P<id>-?[0-9]+)`) and `UserDetailView.get` substitutes the caller:
 *
 * ```python
 * id = int(id)
 * if id == -1:
 *     id = request.user.id
 * ```
 *
 * ⚠️ Only `UserDetailView.get` does this. `UserDetailView.patch` and `.delete` pass the raw
 * id straight through, so in v1 `PATCH /api/user/-1` looks up user `-1` and 404s. Phase 3
 * has to decide whether to keep that asymmetry; {@link resolveUserId} takes the substitution
 * as an explicit argument so neither behavior can be adopted by accident.
 */
export const SELF_USER_ID = -1;

/**
 * Resolves a path id against the caller, applying v1's `-1 == me` substitution.
 *
 * `allowSelfSentinel` mirrors which v1 handler is being ported: `true` for
 * `UserDetailView.get`, `false` for `.patch` / `.delete`.
 */
export function resolveUserId(
  requestedId: number,
  actor: Pick<AuthenticatedUser, 'id'>,
  allowSelfSentinel: boolean,
): number {
  if (allowSelfSentinel && requestedId === SELF_USER_ID) {
    return actor.id;
  }
  return requestedId;
}

/**
 * The ownership predicate the §5 D1 table is written in terms of ("Own profile" vs "Other
 * users"). Compare **resolved** ids: run {@link resolveUserId} first where the route accepts
 * the `-1` sentinel, otherwise `-1` would never equal the caller's id.
 */
export function isSelf(actor: Pick<AuthenticatedUser, 'id'>, targetUserId: number): boolean {
  return actor.id === targetUserId;
}

/**
 * Denies unless the caller owns the target row, or one of `alsoAllowRoles` applies.
 *
 * The 403 body is DRF's generic `PermissionDenied`, identical to the one
 * `APIRolePermission` produces — an ownership failure must not be distinguishable from a
 * role failure, or it becomes a probe for which user ids exist.
 *
 * Callers in Phase 4 (D10: loan reads restricted to the owner plus roles `[0,1,2]`) and
 * Phase 3 (D2: power approval restricted to the requestee) share this.
 */
export function assertOwnership(
  actor: AuthenticatedUser,
  targetUserId: number,
  alsoAllowRoles: readonly number[] = [],
): void {
  if (isSelf(actor, targetUserId)) {
    return;
  }
  const role = actor.profile?.role;
  if (role !== undefined && alsoAllowRoles.includes(role)) {
    return;
  }
  throw DrfException.permissionDenied();
}
