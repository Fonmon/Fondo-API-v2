// Set required env vars before module initialization so AWS/GCS clients don't throw on missing config
process.env.AWS_REGION = process.env.AWS_REGION || 'us-east-1';
process.env.NOTIFICATIONS_QUEUE_URL = process.env.NOTIFICATIONS_QUEUE_URL || 'https://sqs.us-east-1.amazonaws.com/test/test-queue';

import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { AppModule } from '../../../src/app.module';
import { PrismaService } from '../../../src/prisma/prisma.service';
import { MailService } from '../../../src/mail/mail.service';
import { NotificationsService } from '../../../src/notifications/notifications.service';
import { FilesService } from '../../../src/files/files.service';
import { createMockPrismaService } from './prisma.mock';

let appInstance: INestApplication | null = null;
let refCount = 0;

export async function acquireApp(): Promise<INestApplication> {
  refCount++;
  if (!appInstance) {
    const mockPrisma = createMockPrismaService();

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(mockPrisma)
      .overrideProvider(MailService)
      .useValue({ sendMail: jest.fn().mockResolvedValue(true) })
      .compile();

    appInstance = moduleRef.createNestApplication();
    await appInstance.init();

    jest
      .spyOn(appInstance.get(NotificationsService), 'sendNotification')
      .mockResolvedValue(undefined);
    jest
      .spyOn(appInstance.get(NotificationsService), 'scheduleNotification')
      .mockResolvedValue(undefined);
    jest
      .spyOn(appInstance.get(NotificationsService), 'removeScheduledNotifications')
      .mockResolvedValue(undefined);
    const prismaForFiles = appInstance.get(PrismaService) as any;
    jest
      .spyOn(appInstance.get(FilesService), 'getSignedUrl')
      .mockImplementation(async (id: number) => {
        const file = await prismaForFiles.fondo_api_file.findUnique({ where: { id } });
        return file ? 'https://mock-signed-url.example.com/test-file' : null;
      });
    jest
      .spyOn(appInstance.get(FilesService), 'saveFile')
      .mockResolvedValue({ id: 1, display_name: 'mock-file', type_display: 'proceeding' });
  }
  return appInstance!;
}

export async function releaseApp(): Promise<void> {
  refCount--;
  if (refCount === 0 && appInstance) {
    await appInstance.close();
    appInstance = null;
  }
}
