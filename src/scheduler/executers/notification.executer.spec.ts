import type { HstoreMap } from '../../common/utils/hstore.codec';
import type { NotificationService } from '../../notifications/notification.service';
import { NotificationExecuter } from './notification.executer';

/**
 * `fondo_api/scheduler/executers/notification_executer.py`, unit level.
 *
 * The payload is a **real** one — the hstore rendering of `fondodev` row 2458, the birthday
 * task v1 wrote for owner 5 — parsed into the map `parseHstore` produces. Every value is a
 * string, which is the whole point: `user_ids` is a Python list repr that happens to be valid
 * JSON, and `owner_id` is text.
 *
 * v1 has **no** test for this class.
 */
const LIVE_PAYLOAD: HstoreMap = {
  type: 'birthdate',
  target: '/',
  message: 'Hoy está cumpliendo años N@CHO Montañez Herrera',
  owner_id: '5',
  user_ids: '[2, 4, 3, 13, 11, 10, 1, 9, 12, 6, 7, 8]',
};

describe('NotificationExecuter', () => {
  let notifications: { sendNotification: jest.Mock };
  let executer: NotificationExecuter;

  beforeEach(() => {
    notifications = { sendNotification: jest.fn().mockResolvedValue('published') };
    executer = new NotificationExecuter(notifications as unknown as NotificationService);
  });

  it('json.loads-es user_ids out of hstore’s string storage and forwards message and target', async () => {
    await executer.run(LIVE_PAYLOAD);

    expect(notifications.sendNotification).toHaveBeenCalledWith(
      [2, 4, 3, 13, 11, 10, 1, 9, 12, 6, 7, 8],
      'Hoy está cumpliendo años N@CHO Montañez Herrera',
      '/',
    );
  });

  it('passes the payment_reminder shape through unchanged', async () => {
    await executer.run({
      type: 'payment_reminder',
      owner_id: '412',
      user_ids: '[7]',
      target: '/loan/412',
      message: 'Recuerde que la fecha límite de pago para el crédito 412, es el: 30 sep. 2026',
    });

    expect(notifications.sendNotification).toHaveBeenCalledWith(
      [7],
      'Recuerde que la fecha límite de pago para el crédito 412, es el: 30 sep. 2026',
      '/loan/412',
    );
  });

  describe('the outcome it reports back', () => {
    it.each([
      ['published', true],
      ['no-subscriptions', true],
    ] as const)('maps %s to ok = %s', async (delivery, ok) => {
      notifications.sendNotification.mockResolvedValue(delivery);

      await expect(executer.run(LIVE_PAYLOAD)).resolves.toEqual({ ok, detail: delivery });
    });

    /**
     * ⚠️ The cell the phase exists for. v1 cannot produce this distinction at all:
     * `send_notification` swallows the SQS error and returns `None`, the executer returns
     * `None`, and `scheduler/tasks.py` marks the row processed. Here the failure is a value
     * the runner can see — and it must still **not** throw, or the claim would be released
     * and a genuinely undeliverable task would retry twice a day forever.
     */
    it('maps a swallowed publish failure to ok = false without throwing', async () => {
      notifications.sendNotification.mockResolvedValue('failed');

      await expect(executer.run(LIVE_PAYLOAD)).resolves.toEqual({
        ok: false,
        detail: 'failed',
      });
    });
  });

  describe('v1’s KeyError paths (condition C23 — fail closed, never open)', () => {
    it.each(['user_ids', 'message', 'target'])(
      'raises KeyError for a payload with no %s',
      async (key) => {
        const payload = { ...LIVE_PAYLOAD };
        delete payload[key];

        await expect(executer.run(payload)).rejects.toThrow(`KeyError: '${key}'`);
        expect(notifications.sendNotification).not.toHaveBeenCalled();
      },
    );

    it('checks user_ids before message, matching v1’s statement order', async () => {
      const payload = { ...LIVE_PAYLOAD };
      delete payload.user_ids;
      delete payload.message;

      // v1 evaluates `payload["user_ids"]` on its own line, before the call that reads
      // `payload["message"]`, so the first key to fail is the one reported.
      await expect(executer.run(payload)).rejects.toThrow("KeyError: 'user_ids'");
    });

    it('raises TypeError for a NULL user_ids, as json.loads(None) does', async () => {
      await expect(executer.run({ ...LIVE_PAYLOAD, user_ids: null })).rejects.toThrow(TypeError);
    });

    it.each(['message', 'target'])('raises TypeError for a NULL %s (P7-D4)', async (key) => {
      await expect(executer.run({ ...LIVE_PAYLOAD, [key]: null })).rejects.toThrow(
        `scheduler payload key '${key}' is NULL`,
      );
      expect(notifications.sendNotification).not.toHaveBeenCalled();
    });
  });
});
