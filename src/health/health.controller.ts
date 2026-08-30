import { Controller, Get } from '@nestjs/common';
import { HealthService, type HealthReport } from './health.service';

/**
 * The only route Phase 0 ships. It has no v1 counterpart — v1 exposes no health endpoint —
 * so its shape is v2's own and is not covered by any parity criterion.
 * Registered deviation: see `docs/phase-0-deviations.md`, P0-D2.
 */
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get()
  check(): Promise<HealthReport> {
    return this.health.check();
  }
}
