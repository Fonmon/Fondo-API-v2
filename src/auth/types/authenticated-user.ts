import type { Role } from '../permissions/roles';

/**
 * What `TokenAuthGuard` puts on the request — v1's `request.user` (an `auth_user` row) plus
 * the `fondo_api_userprofile` half of Django's multi-table inheritance, which is what
 * `APIRolePermission` reaches for via `request.user.userprofile`.
 *
 * `profile` is **nullable on purpose**: an `auth_user` row with no `fondo_api_userprofile`
 * sibling is reachable (Django's `createsuperuser`, or a half-written MTI insert), and v1
 * answers `403` for it rather than `500` because `APIRolePermission` swallows the
 * `RelatedObjectDoesNotExist`. Never assume it is present in a guard.
 */
export interface AuthenticatedUser {
  /** `auth_user.id`, which is also `fondo_api_userprofile.user_ptr_id`. */
  readonly id: number;
  /** `auth_user.username`. v1 keeps this equal to `email` on every write path. */
  readonly username: string;
  readonly email: string;
  readonly isActive: boolean;
  readonly profile: AuthenticatedUserProfile | null;
}

export interface AuthenticatedUserProfile {
  readonly role: Role;
  readonly identification: bigint;
}

/** The token row that authenticated the request (`request.auth` in DRF). */
export interface AuthenticatedToken {
  readonly key: string;
  readonly created: Date;
}

/** Express request augmented by {@link TokenAuthGuard}. */
export interface RequestWithUser {
  authUser?: AuthenticatedUser;
  authToken?: AuthenticatedToken;
}
