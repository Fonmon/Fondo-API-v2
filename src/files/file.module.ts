import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { FileDetailController } from './file-detail.controller';
import { fileStorageProvider, FILE_STORAGE } from './file-storage';
import { FileController } from './file.controller';
import { FileService } from './file.service';

/**
 * Phase 8 — files. `GET|POST /api/file`, `GET /api/file/<id>`.
 *
 * {@link FILE_STORAGE} is exported so an e2e suite can override it with a fake, the way
 * `SES_CLIENT` and `SQS_CLIENT` are. `AppConfigService` (the bucket name) comes from the
 * global config module.
 */
@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [FileController, FileDetailController],
  providers: [fileStorageProvider, FileService],
  exports: [FileService, FILE_STORAGE],
})
export class FileModule {}
