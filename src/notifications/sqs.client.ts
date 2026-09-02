import { SQSClient, type SQSClientConfig } from '@aws-sdk/client-sqs';
import type { Provider } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';

/**
 * Injection token for the SQS client.
 *
 * v1 builds it at module import in `fondo_api/celery/tasks.py:9`:
 *
 * ```python
 * sqs_client = boto3.client('sqs', region_name=os.environ['AWS_REGION'])
 * ```
 *
 * A provider gives unit tests and `manual-tester` the same seam `@patch('boto3.client')`
 * gives v1's tests.
 */
export const SQS_CLIENT = Symbol('SQS_CLIENT');

/**
 * TCP connect budget. Deliberately short: SQS is in the same region as the app, so a
 * connect that has not completed in a second is not going to.
 */
export const SQS_CONNECTION_TIMEOUT_MS = 1_000;

/**
 * Per-attempt socket budget — condition **C22**, review finding **S4**.
 *
 * With one attempt per `send`, the publisher's 3-attempt loop (200 ms + 400 ms of backoff)
 * bounds a total publish at **3 × 2 000 ms + 600 ms ≈ 6.6 s** wall clock, which is the number
 * Phases 3/4/6 need in order to reason about request latency.
 */
export const SQS_REQUEST_TIMEOUT_MS = 2_000;

/**
 * The client configuration, exported so it can be asserted without constructing a client.
 *
 * ## Why `maxAttempts: 1` — condition **C22** (review finding **S4**)
 *
 * `@aws-sdk/client-sqs` defaults to `maxAttempts: 3` in *standard* retry mode, with its own
 * exponential backoff and jitter, and to **no request timeout at all**. Layered under
 * {@link NotificationPublisher}'s own 3-attempt loop that is **3 × 3 = 9** `SendMessage` HTTP
 * attempts over an unbounded period — and, unlike v1, that time is spent on the HTTP request
 * thread, because v2 publishes inline where v1 handed the work to a Celery worker.
 *
 * Collapsing the queue hop was authorised (Phase 2, §3, condition 1); inheriting a silently
 * multiplied, unbounded retry budget was not. The SDK does **one** attempt; the publisher's
 * loop is the only retry, and it is the one whose behaviour is unit-tested.
 *
 * ⚠️ v1's boto3 default here is `max_attempts = 5` in *legacy* retry mode (botocore's
 * `standard` mode is opt-in and v1 does not opt in), so neither system's SDK default is 3 and
 * neither number was ever deliberate. See `docs/phase-2-deviations.md` P2-D7.
 */
export function sqsClientConfig(config: AppConfigService): SQSClientConfig {
  return {
    region: config.awsRegion,
    maxAttempts: 1,
    requestHandler: {
      connectionTimeout: SQS_CONNECTION_TIMEOUT_MS,
      requestTimeout: SQS_REQUEST_TIMEOUT_MS,
    },
  };
}

export const sqsClientProvider: Provider = {
  provide: SQS_CLIENT,
  inject: [AppConfigService],
  useFactory: (config: AppConfigService): SQSClient => new SQSClient(sqsClientConfig(config)),
};
