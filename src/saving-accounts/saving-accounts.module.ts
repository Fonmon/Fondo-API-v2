import { Module } from '@nestjs/common';
import { SavingAccountsService } from './saving-accounts.service';
import { SavingAccountsController } from './saving-accounts.controller';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [UsersModule],
  providers: [SavingAccountsService],
  controllers: [SavingAccountsController],
})
export class SavingAccountsModule {}
