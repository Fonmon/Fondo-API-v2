import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface HealthReport {
  status: 'ok' | 'degraded';
  database: 'up' | 'down';
}

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(private readonly prisma: PrismaService) {}

  async check(): Promise<HealthReport> {
    try {
      await this.prisma.ping();
      return { status: 'ok', database: 'up' };
    } catch (error) {
      this.logger.error('Database health check failed', error as Error);
      return { status: 'degraded', database: 'down' };
    }
  }
}
