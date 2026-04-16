import {
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Query,
  Req,
} from '@nestjs/common';
import { AdminService } from './admin.service';
import { MaxRole } from '../auth/roles.decorator';
import { UserContext } from '../auth/auth.service';
import { Role } from '../common/enums';

@Controller('api/admin')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get()
  @MaxRole(Role.ADMIN)
  @HttpCode(HttpStatus.OK)
  async handleAdmin(
    @Req() req: { user: UserContext },
    @Query('type') type: string,
  ) {
    if (type === 'email') {
      await this.admin.testEmail(req.user);
    }
    if (type === 'notifications') {
      await this.admin.testNotifications(req.user);
    }
    if (!type) {
      throw new BadRequestException();
    }
    return {};
  }
}
