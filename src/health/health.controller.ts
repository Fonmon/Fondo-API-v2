import { Controller, Get } from '@nestjs/common';
import { Public } from '../auth/decorators/public.decorator';
import { HealthService, type HealthReport } from './health.service';

/**
 * The only route Phase 0 ships. It has no v1 counterpart — v1 exposes no health endpoint —
 * so its shape is v2's own and is not covered by any parity criterion.
 * Registered deviation: see `docs/phase-0-deviations.md`, P0-D2.
 *
 * `@Public()` (Phase 1): the global guards default-deny every route without an entry in the
 * permission matrix, and a liveness probe has to answer before any credential exists. This
 * is the one `@Public()` route with no v1 `permission_classes = []` counterpart, because the
 * route itself has no v1 counterpart.
 */
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Public()
  @Get()
  check(): Promise<HealthReport> {
    return this.health.check();
  }
}
