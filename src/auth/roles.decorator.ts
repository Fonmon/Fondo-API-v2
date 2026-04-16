import { SetMetadata } from '@nestjs/common';

export const ROLES_KEY = 'roles';

export type RoleRequirement =
  | { maxRole: number }
  | { exactRoles: number[] };

/** Allow any user whose role number is <= maxRole (lower = higher privilege). */
export const MaxRole = (maxRole: number) =>
  SetMetadata<string, RoleRequirement>(ROLES_KEY, { maxRole });

/** Allow only users whose role is in the explicit list. */
export const ExactRoles = (...roles: number[]) =>
  SetMetadata<string, RoleRequirement>(ROLES_KEY, { exactRoles: roles });
