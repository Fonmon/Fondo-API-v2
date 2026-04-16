import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  Req,
  HttpCode,
  HttpStatus,
  NotFoundException,
  BadRequestException,
  UseInterceptors,
  UploadedFile,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { UsersService } from './users.service';
import { MaxRole, ExactRoles } from '../auth/roles.decorator';
import { Public } from '../auth/public.decorator';
import { UserContext } from '../auth/auth.service';
import { Role } from '../common/enums';

@Controller('api/user')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Post()
  @MaxRole(Role.ADMIN)
  @HttpCode(HttpStatus.CREATED)
  async createUser(@Body() body: any) {
    return this.users.createUser(body);
  }

  @Get()
  @MaxRole(Role.MEMBER)
  async getUsers(@Query('page') page?: string) {
    const pageNum = page !== undefined ? parseInt(page, 10) : null;
    return this.users.getUsers(pageNum);
  }

  @Patch()
  @ExactRoles(Role.ADMIN, Role.TREASURER)
  @UseInterceptors(FileInterceptor('file'))
  @HttpCode(HttpStatus.OK)
  async bulkUpdateUsers(@UploadedFile() file: Express.Multer.File) {
    if (!file) throw new BadRequestException('No file uploaded');
    await this.users.bulkUpdateUsers(file.buffer);
    return {};
  }

  @Post('activate/:id')
  @Public()
  @HttpCode(HttpStatus.OK)
  async activateUser(@Param('id') id: string, @Body() body: any) {
    const success = await this.users.activateUser(parseInt(id, 10), body);
    if (!success) throw new NotFoundException('Activation failed');
    return {};
  }

  @Get(':id')
  @MaxRole(Role.MEMBER)
  async getUser(@Param('id') id: string, @Req() req: { user: UserContext }) {
    const userId = id === '-1' ? req.user.profileId : parseInt(id, 10);
    const [found, data] = await this.users.getUser(userId);
    if (!found) throw new NotFoundException('User not found');
    return data;
  }

  @Patch(':id')
  @MaxRole(Role.MEMBER)
  @HttpCode(HttpStatus.OK)
  async updateUser(@Param('id') id: string, @Body() body: any) {
    await this.users.updateUser(parseInt(id, 10), body);
    return {};
  }

  @Delete(':id')
  @MaxRole(Role.ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  async inactiveUser(@Param('id') id: string) {
    await this.users.inactiveUser(parseInt(id, 10));
  }

  @Post(':app')
  @MaxRole(Role.MEMBER)
  @HttpCode(HttpStatus.OK)
  async handleApp(
    @Param('app') app: string,
    @Body() body: any,
    @Req() req: { user: UserContext },
  ) {
    if (app === 'birthdates') {
      return this.users.getUsersBirthdate();
    } else if (app === 'power') {
      return this.users.handlePowerRequest(req.user.profileId, body);
    }
    throw new NotFoundException('Unknown app');
  }
}
