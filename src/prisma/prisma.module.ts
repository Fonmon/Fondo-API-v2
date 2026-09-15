import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { SchemaShapeGuard } from './schema-shape.guard';

/**
 * ⚠️ `SchemaShapeGuard` is registered **here**, not in `main.ts` — §4 rule 12's corollary.
 * Every e2e suite builds the app from `AppModule`, so anything installed in `main.ts` is
 * unexercised, and a boot guard that no test ever boots is a guard nobody has run. Its
 * `onModuleInit` therefore runs on every e2e app build as well as in production.
 */
@Global()
@Module({
  providers: [PrismaService, SchemaShapeGuard],
  exports: [PrismaService],
})
export class PrismaModule {}
