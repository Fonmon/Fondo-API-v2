/**
 * Standalone scheduler process — mirrors Django's Celery Beat worker.
 * Run with:  npm run start:scheduler
 * Production: npm run start:scheduler:prod
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { SchedulerModule } from './scheduler.module';

async function bootstrap() {
  const logger = new Logger('Scheduler');
  // createApplicationContext boots NestJS without an HTTP server
  await NestFactory.createApplicationContext(SchedulerModule);
  logger.log('Scheduler started — cron fires at 10:00 and 14:00 UTC daily');
}

bootstrap().catch((err) => {
  new Logger('Scheduler').error('Failed to start scheduler', err);
  process.exit(1);
});
