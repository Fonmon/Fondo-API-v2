import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { AppConfigService } from '../config/app-config.service';
import { PrismaClient } from './prisma-client';

/**
 * Prisma Client as a Nest provider.
 *
 * Notes for anyone touching the data layer:
 *
 *  * **Django owns the schema until cutover.** Never run `prisma migrate dev` against a
 *    database v1 also uses. The baseline (`prisma/migrations/0_init`) is marked applied,
 *    not executed.
 *  * **`auto_now` / `auto_now_add` are application-set in Django, not DB defaults.** There
 *    is no `DEFAULT now()` on `created_at`, `last_modified` or `date_joined`; v2 must pass
 *    them on every insert or hit a NOT NULL violation.
 *  * **Cascades are Python-side in Django.** Every physical FK is `NO ACTION`, so deleting
 *    a parent row does not delete its children — do it explicitly, inside a transaction.
 *  * **The two hstore columns are invisible to this client.** They are
 *    `Unsupported("hstore")`; read them with `SELECT ...::text` and the Phase 0 hstore
 *    codec, only from `NotificationSubscriptionRepository` (Phase 2) and
 *    `SchedulerTaskRepository` (Phase 7).
 *  * **Sequences are shared with v1 during parity testing.** Never let v2 set a primary key
 *    explicitly on a table v1 also writes.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor(config: AppConfigService) {
    super({
      // Prisma 7 requires a driver adapter; `pg` also gives the two raw-SQL hstore
      // repositories a first-class parameterised-query path.
      adapter: new PrismaPg({ connectionString: config.databaseUrl }),
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Connected to PostgreSQL');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /** Cheap liveness probe used by `GET /health`. */
  async ping(): Promise<boolean> {
    await this.$queryRaw`SELECT 1`;
    return true;
  }
}
