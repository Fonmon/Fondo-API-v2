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
 * ⚠️ It is deliberately narrow, and **the reason originally given here was wrong.** This block
 * used to claim a `NOT NULL` violation could not reach either handler "in practice". Deviation
 * **D35** falsifies that for `create_user`: `POST /api/user` with `{"first_name": null}` puts a
 * SQL NULL in a `NOT NULL` column, and Django answers **409** through exactly this path. Use
 * {@link isIntegrityError} where v1 catches the whole class.
 *
 * The narrowness still matters for `create_year`, whose `year` is computed rather than taken
 * from the body: only a `UNIQUE` violation is reachable there, and widening it would convert a
 * genuine 500 into a bodiless 304 — a write that reports "not modified".
 */
export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

/**
 * The whole of `django.db.IntegrityError` — every constraint PostgreSQL can refuse a write
 * with, as Django's one exception class sees them.
 *
 * | SQLSTATE | constraint | Prisma |
 * |---|---|---|
 * | `23505` | `UNIQUE` | `P2002` |
 * | `23502` | `NOT NULL` | `P2011` |
 * | `23503` | `FOREIGN KEY` | `P2003` |
 *
 * Use this **only** where v1 writes `except IntegrityError:` around a body-derived write, so
 * the same inputs produce the same status. `create_user` is the one such site today (**D35**);
 * `create_year` deliberately keeps {@link isUniqueViolation}.
 */
export function isIntegrityError(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    (error.code === 'P2002' || error.code === 'P2011' || error.code === 'P2003')
  );
}
