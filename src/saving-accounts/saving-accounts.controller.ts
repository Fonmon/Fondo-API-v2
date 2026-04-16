import {
  Controller,
  Get,
  Post,
  Put,
  Body,
  Query,
  Req,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { SavingAccountsService } from './saving-accounts.service';
import { MaxRole, ExactRoles } from '../auth/roles.decorator';
import { UserContext } from '../auth/auth.service';
import { Role } from '../common/enums';

@Controller('api/saving-account')
export class SavingAccountsController {
  constructor(private readonly savingAccounts: SavingAccountsService) {}

  @Get()
  @MaxRole(Role.MEMBER)
  async getAccounts(
    @Query('page') page?: string,
    @Query('state') state?: string,
    @Req() req?: { user: UserContext },
  ) {
    const user = req!.user;
    const pageNum = page !== undefined ? parseInt(page, 10) : null;
    const stateNum = state !== undefined ? parseInt(state, 10) : null;
    const allAccounts = user.role <= 2;
    const shouldPaginate = pageNum !== null;
    return this.savingAccounts.getAccounts(user.profileId, pageNum, allAccounts, stateNum, shouldPaginate);
  }

  @Post()
  @MaxRole(Role.MEMBER)
  @HttpCode(HttpStatus.OK)
  async createAccount(@Body() body: any, @Req() req: { user: UserContext }) {
    return this.savingAccounts.createAccount(req.user.profileId, body);
  }

  @Put()
  @ExactRoles(Role.ADMIN, Role.TREASURER)
  @HttpCode(HttpStatus.OK)
  async updateAccount(@Body() body: any) {
    return this.savingAccounts.updateAccount(body);
  }
}
