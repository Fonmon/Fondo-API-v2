import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import configuration from './config/configuration';
import { PrismaModule } from './prisma/prisma.module';
import { MailModule } from './mail/mail.module';
import { AuthModule } from './auth/auth.module';
import { NotificationsModule } from './notifications/notifications.module';
import { UsersModule } from './users/users.module';
import { LoansModule } from './loans/loans.module';
import { ActivitiesModule } from './activities/activities.module';
import { SavingAccountsModule } from './saving-accounts/saving-accounts.module';
import { FilesModule } from './files/files.module';
import { AdminModule } from './admin/admin.module';
import { SchedulerModule } from './scheduler/scheduler.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
    }),
    PrismaModule,
    MailModule,
    AuthModule,
    NotificationsModule,
    UsersModule,
    LoansModule,
    ActivitiesModule,
    SavingAccountsModule,
    FilesModule,
    AdminModule,
    SchedulerModule,
  ],
})
export class AppModule {}
