import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  Query,
  Req,
  HttpCode,
  HttpStatus,
  NotFoundException,
  BadRequestException,
  HttpException,
  UseInterceptors,
  UploadedFile,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { LoansService } from './loans.service';
import { MaxRole, ExactRoles } from '../auth/roles.decorator';
import { UserContext } from '../auth/auth.service';
import { Role } from '../common/enums';

@Controller('api/loan')
export class LoansController {
  constructor(private readonly loans: LoansService) {}

  @Get()
  @MaxRole(Role.MEMBER)
  async getLoans(
    @Query('page') page?: string,
    @Query('state') state?: string,
    @Req() req?: { user: UserContext },
  ) {
    const pageNum = page !== undefined ? parseInt(page, 10) : null;
    const stateNum = state !== undefined ? parseInt(state, 10) : 4;
    if (pageNum !== null && pageNum <= 0) {
      throw new BadRequestException('Page number must be greater or equal than 0');
    }
    if (stateNum < 0 || stateNum > 4) {
      throw new BadRequestException('State must be between 0 and 4');
    }
    const user = req!.user;
    const allLoans = user.role <= 2;
    const shouldPaginate = pageNum !== null;
    return this.loans.getLoans(user.profileId, pageNum, allLoans, stateNum, shouldPaginate);
  }

  @Post()
  @MaxRole(Role.MEMBER)
  @HttpCode(HttpStatus.CREATED)
  async createLoan(@Body() body: any, @Req() req: { user: UserContext }) {
    const result = await this.loans.createLoan(req.user.profileId, body);
    if (result === null) {
      throw new HttpException(
        { message: 'User does not have available quota' },
        HttpStatus.NOT_ACCEPTABLE,
      );
    }
    return result;
  }

  @Patch()
  @ExactRoles(Role.ADMIN, Role.TREASURER)
  @UseInterceptors(FileInterceptor('file'))
  @HttpCode(HttpStatus.OK)
  async bulkUpdateLoans(@UploadedFile() file: Express.Multer.File) {
    if (!file) throw new BadRequestException('No file uploaded');
    await this.loans.bulkUpdateLoans(file.buffer);
    return {};
  }

  @Get(':id')
  @MaxRole(Role.MEMBER)
  async getLoan(@Param('id') id: string) {
    const result = await this.loans.getLoan(parseInt(id, 10));
    if (!result) throw new NotFoundException('Loan not found');
    return result;
  }

  @Patch(':id')
  @ExactRoles(Role.ADMIN, Role.TREASURER)
  @HttpCode(HttpStatus.OK)
  async updateLoan(@Param('id') id: string, @Body() body: { state: number }) {
    const state = Number(body.state);
    if (state > 3) {
      throw new BadRequestException('State must be less or equal than 3');
    }
    const result = await this.loans.updateLoan(parseInt(id, 10), state);
    if (result === null) throw new NotFoundException('Loan does not exist');
    return result;
  }

  @Post(':id/:app')
  @MaxRole(Role.MEMBER)
  @HttpCode(HttpStatus.OK)
  async handleApp(
    @Param('id') id: string,
    @Param('app') app: string,
    @Body() body: any,
    @Req() req: { user: UserContext },
  ) {
    const loanId = parseInt(id, 10);

    if (app === 'paymentProjection') {
      if (!body.to_date) {
        throw new BadRequestException('to_date is required');
      }
      const result = await this.loans.paymentProjection(loanId, body.to_date);
      if (!result) throw new NotFoundException('Loan not found or no details');
      return result;
    } else if (app === 'refinance') {
      const result = await this.loans.refinanceLoan(loanId, body, req.user.profileId);
      if (!result) throw new BadRequestException('Cannot refinance this loan');
      return result;
    }

    throw new NotFoundException('Unknown app');
  }
}
