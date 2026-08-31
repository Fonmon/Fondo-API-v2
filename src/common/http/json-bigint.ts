import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';

/**
 * How a Prisma `BigInt` reaches the wire. **Decided once, globally** — reviewer finding S2,
 * plan §4 rule 5b.
 *
 * ## The problem
 *
 * 17 columns are `BigInt` in `schema.prisma` — every money field (`UserFinance.contributions`,
 * `balance_contributions`, `total_quota`, `utilized_quota`, `available_quota`,
 * `Loan.value`, `Loan.disbursement_value`, `LoanDetail.*`, `SavingAccount.value`) plus
 * `UserProfile.identification`. `JSON.stringify(1n)` throws
 * `TypeError: Do not know how to serialize a BigInt`, so the first Phase 3 response carrying
 * a money field would 500.
 *
 * ## The decision: a JSON **number**, never a string
 *
 * v1 renders `models.BigIntegerField` through DRF's `IntegerField`, whose `to_representation`
 * is `int(value)` — a bare JSON number:
 *
 * ```json
 * {"contributions": 1000, "total_quota": 2000}
 * ```
 *
 * The reflex fix `BigInt.prototype.toJSON = function () { return this.toString() }` renders
 * `"1000"` and would silently break every client and every parity assertion. It is also a
 * global prototype mutation, which is why this module does the opposite: it changes nothing
 * about `BigInt` and instead installs Express's `json replacer`, so the conversion happens at
 * exactly one point — the moment a response is stringified.
 *
 * ## Why a replacer and not an interceptor
 *
 * An interceptor would have to deep-clone the payload, and cloning silently degrades class
 * instances (DTOs, `Decimal`, `Date`) into plain objects. `JSON.stringify`'s replacer visits
 * every value at serialization time regardless of prototype, so nested envelopes
 * (`{list: [...], num_pages, count}`), class instances and error bodies are all covered with
 * no copying. Express 5 applies `app.get('json replacer')` inside `res.json()`, which is what
 * both Nest's route handler and {@link ApiExceptionFilter} use.
 *
 * ## Precision
 *
 * A JS `number` holds integers exactly only up to 2^53 − 1. Rather than lose a cent silently,
 * a value outside the safe range **throws** — which surfaces as a 500 and a stack trace
 * instead of a corrupted balance. The fund's largest realistic amount is roughly 10^9 COP and
 * the largest `identification` is 10 digits, so this is a tripwire, not a limit.
 */

/** `Number.MAX_SAFE_INTEGER` as a bigint, i.e. 2^53 − 1. */
export const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
/** `Number.MIN_SAFE_INTEGER` as a bigint. */
export const MIN_SAFE_BIGINT = BigInt(Number.MIN_SAFE_INTEGER);

/** Thrown instead of rendering a money value that a JS `number` cannot hold exactly. */
export class BigIntPrecisionError extends RangeError {
  constructor(readonly value: bigint) {
    super(
      `Cannot render ${value.toString()} as a JSON number without losing precision ` +
        `(outside ±(2^53 - 1)). v1 renders BigIntegerField as a bare JSON number; widening ` +
        `this to a string would be a response-shape change and needs a registered deviation.`,
    );
    this.name = 'BigIntPrecisionError';
  }
}

/** Converts one bigint to the number DRF would have rendered, or throws. */
export function bigIntToJsonNumber(value: bigint): number {
  if (value > MAX_SAFE_BIGINT || value < MIN_SAFE_BIGINT) {
    throw new BigIntPrecisionError(value);
  }
  return Number(value);
}

/**
 * `JSON.stringify` replacer: bigint → number, everything else untouched.
 *
 * Declared as a plain function (not an arrow) only for symmetry with Express's expectation;
 * it does not use `this`.
 */
export function bigIntJsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? bigIntToJsonNumber(value) : value;
}

/** `JSON.stringify` with the same replacer the HTTP layer uses. For tests and logging. */
export function stringifyWithBigInt(value: unknown): string {
  return JSON.stringify(value, bigIntJsonReplacer);
}

/**
 * Installs {@link bigIntJsonReplacer} on the Express instance.
 *
 * Registered as an ordinary provider of `AppModule`, so **every** way of building the app —
 * `main.ts`, and every e2e suite that imports `AppModule` — gets it. A provider was chosen
 * over a line in `main.ts` precisely so the e2e suites exercise the production wiring.
 */
@Injectable()
export class JsonBigIntSetup implements OnModuleInit {
  private readonly logger = new Logger(JsonBigIntSetup.name);

  constructor(private readonly adapterHost: HttpAdapterHost) {}

  onModuleInit(): void {
    const instance: unknown = this.adapterHost.httpAdapter?.getInstance();
    if (!isExpressApplication(instance)) {
      // Unit-test `TestingModule`s have no HTTP adapter. Nothing to configure, and nothing
      // can serialize a response either.
      this.logger.debug('No Express instance available; BigInt JSON replacer not installed.');
      return;
    }
    instance.set('json replacer', bigIntJsonReplacer);
  }
}

interface ExpressLikeApplication {
  set(setting: string, value: unknown): unknown;
}

function isExpressApplication(instance: unknown): instance is ExpressLikeApplication {
  // An Express 5 application is a *function* that also carries `set`, so `typeof` alone is
  // not enough to recognise it.
  if (instance === null || (typeof instance !== 'object' && typeof instance !== 'function')) {
    return false;
  }
  return typeof (instance as ExpressLikeApplication).set === 'function';
}
