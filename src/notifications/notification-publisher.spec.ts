import { SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { AppConfigService } from '../config/app-config.service';
import {
  NotificationPublisher,
  type NotificationContent,
  type NotificationPublishRetry,
} from './notification-publisher';

/**
 * `fondo_api/celery/tasks.py:send_notification` — and the four conditions the plan attached
 * to collapsing v1's Celery hop into an inline publish.
 *
 * v1 has **no** test for this function; `pending_test_send_notification` in
 * `test_notification_views.py` is prefixed `pending_` and never runs (and patches
 * `requests.post`, which is dead code from the pre-SQS design). Plan §Phase 2 therefore
 * requires extra coverage here, which is what this file and
 * `notification-subscription.repository` round-trip e2e provide.
 */
const QUEUE_URL = 'https://sqs.us-east-2.amazonaws.com/1234/notifications';

const CONTENT: NotificationContent = {
  subscriptions: [
    {
      keys: { p256dh: 'A-B_c', auth: 'x' },
      endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
      expirationTime: null,
    },
  ],
  message: { body: 'Ha sido creada una nueva solicitud de crédito', target: '/loan/1' },
};

/** Captured from `json.dumps(content)` on CPython 3.9. */
const EXPECTED_BODY =
  '{"subscriptions": [{"keys": {"p256dh": "A-B_c", "auth": "x"}, "endpoint": ' +
  '"https://fcm.googleapis.com/fcm/send/abc", "expirationTime": null}], "message": ' +
  '{"body": "Ha sido creada una nueva solicitud de cr\\u00e9dito", "target": "/loan/1"}}';

/** Each publisher's silenced `Logger.log` spy, so its lines can be read back in order. */
const logSpies = new WeakMap<NotificationPublisher, jest.SpyInstance>();

describe('NotificationPublisher', () => {
  let sqs: { send: jest.Mock };
  let publisher: NotificationPublisher;

  // ⚠️ No default for `queueUrl`: a default parameter also fires for an explicit
  // `undefined`, which would make the "missing NOTIFICATIONS_QUEUE_URL" case untestable.
  function build(
    queueUrl: string | undefined,
    retry: NotificationPublishRetry = { attempts: 3, baseDelayMs: 0 },
  ): NotificationPublisher {
    const config = { notificationsQueueUrl: queueUrl } as AppConfigService;
    const instance = new NotificationPublisher(sqs as unknown as SQSClient, config, retry);
    jest.spyOn(instance['logger'], 'error').mockImplementation(() => undefined);
    jest.spyOn(instance['logger'], 'warn').mockImplementation(() => undefined);
    // Kept, rather than re-read later: `instance['logger'].log` is a *method* reference and
    // reading one into a variable is what `@typescript-eslint/unbound-method` forbids.
    logSpies.set(
      instance,
      jest.spyOn(instance['logger'], 'log').mockImplementation(() => undefined),
    );
    return instance;
  }

  beforeEach(() => {
    sqs = { send: jest.fn().mockResolvedValue({ MessageId: 'msg-1' }) };
    publisher = build(QUEUE_URL);
  });

  describe('the SQS payload', () => {
    it('sends json.dumps bytes, not JSON.stringify bytes', async () => {
      await expect(publisher.publish(CONTENT)).resolves.toBe(true);

      expect(sqs.send).toHaveBeenCalledTimes(1);
      const calls = sqs.send.mock.calls as unknown as [SendMessageCommand][];
      const command = calls[0][0];
      expect(command).toBeInstanceOf(SendMessageCommand);
      expect(command.input).toEqual({ QueueUrl: QUEUE_URL, MessageBody: EXPECTED_BODY });
    });

    it('sends nothing but QueueUrl and MessageBody — v1 passes no other parameter', async () => {
      await publisher.publish(CONTENT);
      const calls = sqs.send.mock.calls as unknown as [SendMessageCommand][];
      const input = calls[0][0].input;
      expect(Object.keys(input)).toEqual(['QueueUrl', 'MessageBody']);
    });
  });

  /**
   * **Condition C73.** `fondo_api/celery/tasks.py:15` logs this on every publish and v2 did
   * not; the line is the only *attempt* marker the subsystem has, so its absence makes a
   * publish that dies before either terminal line invisible.
   */
  describe('the attempt line — v1’s `Sending request to MNS...` (C73)', () => {
    it('logs it before anything else, on a successful publish', async () => {
      await expect(publisher.publish(CONTENT)).resolves.toBe(true);

      expect(logLines(publisher)).toEqual(['Sending request to MNS...', 'Message sent, id: msg-1']);
    });

    /**
     * ⚠️ v1 logs it *before* reading `NOTIFICATIONS_QUEUE_URL`, so the unconfigured case
     * still leaves an attempt line. That is the whole point of porting it: this branch
     * otherwise emits one error and no evidence that a publish was tried.
     */
    it('logs it even when NOTIFICATIONS_QUEUE_URL is unset and nothing is sent', async () => {
      const unconfigured = build(undefined);

      await expect(unconfigured.publish(CONTENT)).resolves.toBe(false);

      expect(logLines(unconfigured)).toEqual(['Sending request to MNS...']);
      expect(sqs.send).not.toHaveBeenCalled();
    });

    it('logs exactly one attempt line for a publish that is retried three times', async () => {
      sqs.send.mockRejectedValue(new Error('ServiceUnavailable'));

      await expect(publisher.publish(CONTENT)).resolves.toBe(false);

      // v1 logs it once per `send_notification` call, not once per boto3 attempt — v1 has
      // no retry loop at all, so "once per publish" is the only reading that ports.
      expect(logLines(publisher).filter((line) => line.startsWith('Sending'))).toHaveLength(1);
      expect(sqs.send).toHaveBeenCalledTimes(3);
    });
  });

  describe('condition 1 — bounded retry with backoff, 3 attempts', () => {
    it('retries a transient failure and succeeds on the second attempt', async () => {
      sqs.send
        .mockRejectedValueOnce(new Error('ThrottlingException'))
        .mockResolvedValueOnce({ MessageId: 'msg-2' });

      await expect(publisher.publish(CONTENT)).resolves.toBe(true);
      expect(sqs.send).toHaveBeenCalledTimes(2);
    });

    it('gives up after exactly 3 attempts', async () => {
      sqs.send.mockRejectedValue(new Error('ServiceUnavailable'));

      await expect(publisher.publish(CONTENT)).resolves.toBe(false);
      expect(sqs.send).toHaveBeenCalledTimes(3);
    });

    it('backs off with a doubling delay between attempts', async () => {
      jest.useFakeTimers();
      try {
        const delays: number[] = [];
        jest.spyOn(globalThis, 'setTimeout').mockImplementation(((
          callback: () => void,
          ms?: number,
        ) => {
          delays.push(ms ?? 0);
          callback();
          return 0 as unknown as NodeJS.Timeout;
        }) as never);

        const withDelay = build(QUEUE_URL, { attempts: 3, baseDelayMs: 200 });
        sqs.send.mockRejectedValue(new Error('nope'));

        await expect(withDelay.publish(CONTENT)).resolves.toBe(false);
        expect(delays).toEqual([200, 400]);
      } finally {
        jest.restoreAllMocks();
        jest.useRealTimers();
      }
    });
  });

  describe('condition 2 — the failure is swallowed at the boundary', () => {
    it('never rejects when SQS fails', async () => {
      sqs.send.mockRejectedValue(new Error('boom'));
      await expect(publisher.publish(CONTENT)).resolves.toBe(false);
    });

    it('never rejects when the SQS client throws synchronously', async () => {
      sqs.send.mockImplementation(() => {
        throw new Error('no credentials');
      });
      await expect(publisher.publish(CONTENT)).resolves.toBe(false);
    });

    it('never rejects when the content cannot be serialised', async () => {
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      await expect(publisher.publish(circular as never)).resolves.toBe(false);
      expect(sqs.send).not.toHaveBeenCalled();
    });
  });

  describe('a missing NOTIFICATIONS_QUEUE_URL', () => {
    it('fails once without retrying and without calling SQS', async () => {
      const unconfigured = build(undefined);

      await expect(unconfigured.publish(CONTENT)).resolves.toBe(false);
      expect(sqs.send).not.toHaveBeenCalled();
      // v1 hands boto3 `QueueUrl=None`, which raises ParamValidationError on the first and
      // only attempt and is swallowed. Retrying a configuration error changes nothing.
    });
  });
});

/**
 * The `Logger.log` lines a publisher emitted, in order. A helper rather than three inline
 * casts: `publisher['logger'].log` is a spied *method*, and reading it into a variable is
 * what `@typescript-eslint/unbound-method` exists to stop.
 */
function logLines(instance: NotificationPublisher): string[] {
  const spy = logSpies.get(instance);
  if (spy === undefined) {
    throw new Error('logLines: this publisher was not built by build()');
  }
  return (spy.mock.calls as string[][]).map((call) => call[0]);
}
