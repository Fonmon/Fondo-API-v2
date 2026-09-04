import { Prisma } from '../../prisma/prisma-client';

/**
 * `django.db.IntegrityError` raised by a `UNIQUE` constraint — PostgreSQL `SQLSTATE 23505`,
 * which Prisma surfaces as `P2002`.
 *
 * Two v1 services branch on it and answer differently, so the predicate is shared rather
 * than re-written per feature module:
 *
 * | v1 | on `IntegrityError` |
 * |---|---|
 * | `UserService.create_user` (`services/user.py:54`) | `(False, 'Identification/email already exists')` → **409** |
 * | `ActivityService.create_year` (`services/activity.py:24`) | `return False` → **304**, bodiless |
 *
 * ⚠️ It is deliberately narrow. A `NOT NULL` violation is `23502` / `P2011` and a foreign-key
 * violation is `23503` / `P2003`; both are `IntegrityError` in Django too, but neither v1
 * `except IntegrityError:` above can be reached by them in practice, and widening this would
 * silently convert a 500 into a 304 or a 409.
 */
export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
