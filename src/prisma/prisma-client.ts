/**
 * The single place that knows where `prisma generate` writes its output.
 *
 * The generator targets `<repo>/generated/prisma` (already listed in `.gitignore`), which
 * is outside `src`, so exactly one relative import is allowed to reach out of the source
 * tree — this one. Everything else imports from here.
 */
export { Prisma, PrismaClient } from '../../generated/prisma';
export type * from '../../generated/prisma';
