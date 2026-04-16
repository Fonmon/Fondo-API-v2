import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  HttpCode,
  HttpStatus,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { ActivitiesService } from './activities.service';
import { MaxRole } from '../auth/roles.decorator';
import { Role } from '../common/enums';

@Controller('api/activity')
export class ActivitiesController {
  constructor(private readonly activities: ActivitiesService) {}

  @Get('year')
  @MaxRole(Role.MEMBER)
  async getYears() {
    return this.activities.getYears();
  }

  @Post('year')
  @MaxRole(Role.PRESIDENT)
  @HttpCode(HttpStatus.CREATED)
  async createYear() {
    const result = await this.activities.createYear();
    if (result === false) return { error: 'Year already exists' };
    return result;
  }

  @Get('year/:id_year')
  @MaxRole(Role.MEMBER)
  async getActivities(@Param('id_year') idYear: string) {
    return this.activities.getActivities(parseInt(idYear, 10));
  }

  @Post('year/:id_year')
  @MaxRole(Role.PRESIDENT)
  @HttpCode(HttpStatus.CREATED)
  async createActivity(@Param('id_year') idYear: string, @Body() body: any) {
    return this.activities.createActivity(body, parseInt(idYear, 10));
  }

  @Get(':id')
  @MaxRole(Role.MEMBER)
  async getActivity(@Param('id') id: string) {
    const result = await this.activities.getActivity(parseInt(id, 10));
    if (!result) throw new NotFoundException('Activity not found');
    return result;
  }

  @Delete(':id')
  @MaxRole(Role.PRESIDENT)
  @HttpCode(HttpStatus.OK)
  async removeActivity(@Param('id') id: string) {
    await this.activities.removeActivity(parseInt(id, 10));
  }

  @Patch(':id')
  @MaxRole(Role.PRESIDENT)
  @HttpCode(HttpStatus.OK)
  async patchActivity(
    @Param('id') id: string,
    @Query('patch') patch: string,
    @Body() body: any,
  ) {
    if (patch !== 'activity' && patch !== 'user') {
      throw new BadRequestException();
    }
    const result = await this.activities.patchActivity(patch, parseInt(id, 10), body);
    if (result === null) throw new NotFoundException('Unknown patch type');
    return result;
  }
}
