/**
 * `fondo_api/models.py:UserProfile.ROLES`. The numeric order is load-bearing: the integer
 * form of a permission rule is `role <= N`, so **lower is more privileged**.
 */
export enum Role {
  ADMIN = 0,
  PRESIDENT = 1,
  TREASURER = 2,
  MEMBER = 3,
}

/** Every role, ascending — handy for table-driven tests. */
export const ALL_ROLES: readonly Role[] = [
  Role.ADMIN,
  Role.PRESIDENT,
  Role.TREASURER,
  Role.MEMBER,
] as const;
