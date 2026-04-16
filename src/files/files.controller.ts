import {
  Controller,
  Get,
  Post,
  Param,
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
import { FilesService } from './files.service';
import { MaxRole } from '../auth/roles.decorator';
import { UserContext } from '../auth/auth.service';
import { Role } from '../common/enums';

@Controller('api/file')
export class FilesController {
  constructor(private readonly files: FilesService) {}

  @Post()
  @MaxRole(Role.ADMIN)
  @UseInterceptors(FileInterceptor('file'))
  @HttpCode(HttpStatus.CREATED)
  async saveFile(
    @UploadedFile() file: Express.Multer.File,
    @Query('type') type?: string,
  ) {
    if (!file) throw new BadRequestException('No file uploaded');
    const typeNum = type !== undefined ? parseInt(type, 10) : 0;
    return this.files.saveFile(file.originalname, typeNum, file.buffer, file.mimetype);
  }

  @Get()
  @MaxRole(Role.MEMBER)
  async getFiles(@Query('type') type?: string) {
    const typeNum = type !== undefined ? parseInt(type, 10) : -1;
    return this.files.getFiles(typeNum);
  }

  @Get(':id')
  @MaxRole(Role.MEMBER)
  async getSignedUrl(@Param('id') id: string) {
    const url = await this.files.getSignedUrl(parseInt(id, 10));
    if (!url) throw new NotFoundException('File not found');
    return { url };
  }
}
