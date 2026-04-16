import { Module } from '@nestjs/common';
import { LoansService } from './loans.service';
import { LoansController } from './loans.controller';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [UsersModule],
  providers: [LoansService],
  controllers: [LoansController],
  exports: [LoansService],
})
export class LoansModule {}
