import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { NotificationModule } from '../notifications/notification.module';
import { PrismaModule } from '../prisma/prisma.module';
import { SchedulerModule } from '../scheduler/scheduler.module';
import { UserModule } from '../users/user.module';
import { SavingAccountController } from './saving-account.controller';
import { SavingAccountService } from './saving-account.service';

/**
 * Phase 6 — saving accounts (CAPs).
 *
 * One route, one view: `GET|POST|PUT /api/saving-account`. Controller order is not
 * load-bearing here — the pattern has no sibling it can collide with, unlike Phase 5's
 * `/api/activity/year` vs `/api/activity/:id`.
 *
 * The imports mirror v1's own wiring plus one addition:
 *
 * | import | why |
 * |---|---|
 * | {@link UserModule} | `views/saving_account.py:9` builds a `UserService()` — `get_profile`, `get_users_attr` |
 * | {@link NotificationModule} | `:10` builds a `NotificationService()` — the create notification |
 * | {@link PrismaModule} | the data layer |
 * | {@link AuthModule} | the guards, as every feature module does |
 * | {@link SchedulerModule} | **D12 only** — writing the CAP close task. v1 has a `# TODO` here and no scheduler write at all |
 *
 * ⚠️ The *executer* that runs those tasks lives in {@link SchedulerRunnerModule}, not here,
 * and that module imports this one. The dependency runs one way — Phase 6 writes tasks,
 * Phase 7b's runner executes them — which keeps the graph acyclic and matches v1's layout,
 * where `fondo_api/scheduler/` imports the services and nothing imports back.
 */
@Module({
  imports: [PrismaModule, AuthModule, UserModule, NotificationModule, SchedulerModule],
  controllers: [SavingAccountController],
  providers: [SavingAccountService],
  exports: [SavingAccountService],
})
export class SavingAccountModule {}
