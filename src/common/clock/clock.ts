import { Injectable, Module } from '@nestjs/common';
import { nowInstant } from '../utils/timezone.util';

/**
 * **Phase 8b / D48.** The injectable "now".
 *
 * A calendar decision that depends on the wall clock — D48's "is a scheduler pass still to run
 * today?" — has to be testable at an exact instant, including the boundary instants
 * `13:59:59.999` and `14:00:00.000` Bogotá. `jest.useFakeTimers()` can do that too, but it
 * patches a global: a cell that forgets `useRealTimers()` leaks its clock into the next one.
 * A provider is overridden per module and per cell instead.
 *
 * ⚠️ **An instant, never a calendar date.** The zone is applied by the caller through
 * `timezone.util.ts` (plan §4 rule 5). A `Clock` that returned a `PlainDate` would have to
 * choose a zone itself, and the host zone is the one it would reach for.
 */
export abstract class Clock {
  abstract now(): Date;
}

/** Production clock: {@link nowInstant}. */
@Injectable()
export class SystemClock extends Clock {
  now(): Date {
    return nowInstant();
  }
}

@Module({
  providers: [{ provide: Clock, useClass: SystemClock }],
  exports: [Clock],
})
export class ClockModule {}
