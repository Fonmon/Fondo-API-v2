import type { Logger } from '@nestjs/common';
import type { HstoreMap } from '../../common/utils/hstore.codec';
import type { NotificationService } from '../../notifications/notification.service';
import type { MemberDirectory } from '../member-directory';
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
  let members: { ownerStatus: jest.Mock; activeMemberIdsExcept: jest.Mock };
  let executer: NotificationExecuter;
  let logged: jest.SpyInstance;

  /** The live roster in 2026: user 3 left, user 14 (Ainhoa) joined, owner 5 excluded. */
  const ACTIVE_NOW = [2, 4, 13, 11, 10, 1, 9, 12, 6, 7, 8, 14];

  beforeEach(() => {
    notifications = { sendNotification: jest.fn().mockResolvedValue('published') };
    members = {
      ownerStatus: jest.fn().mockResolvedValue('active'),
      activeMemberIdsExcept: jest.fn().mockResolvedValue(ACTIVE_NOW),
    };
    executer = new NotificationExecuter(
      notifications as unknown as NotificationService,
      members as unknown as MemberDirectory,
    );
    logged = jest
      .spyOn((executer as unknown as { logger: Logger }).logger, 'log')
      .mockImplementation(() => undefined);
  });

  /**
   * ⚠️ **Re-subjected in Phase 8b (D49).** Until `11b8c5a` this cell asserted that the birthday
   * greeting went to the stored `user_ids`, `[2, 4, 3, 13, …]`. Under D49 the stored list is
   * still parsed (§2.3 of `docs/phase-8b-deviations.md`) but no longer names the audience. The
   * v1 pass-through it used to pin is still pinned, for payment reminders, by the next cell.
   */
  it('json.loads-es user_ids out of hstore’s string storage and forwards message and target', async () => {
    await executer.run(LIVE_PAYLOAD);

    expect(notifications.sendNotification).toHaveBeenCalledWith(
      ACTIVE_NOW,
      'Hoy está cumpliendo años N@CHO Montañez Herrera',
      '/',
    );
    expect(members.activeMemberIdsExcept).toHaveBeenCalledWith(5);
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

  // ---------------------------------------------------------------------------------------
  // Phase 8b
  // ---------------------------------------------------------------------------------------

  const REMINDER: HstoreMap = {
    type: 'payment_reminder',
    owner_id: '412',
    user_ids: '[7]',
    target: '/loan/412',
    message: 'Recuerde que la fecha límite de pago para el crédito 412, es el: 30 sep. 2026',
  };

  describe('D39 — a departed owner is not announced (Q35, Q48)', () => {
    it('sends nothing for an inactive owner, and returns rather than throws', async () => {
      members.ownerStatus.mockResolvedValue('inactive');

      await expect(executer.run(LIVE_PAYLOAD)).resolves.toEqual({
        ok: true,
        detail: 'owner-inactive',
      });
      expect(members.ownerStatus).toHaveBeenCalledWith(5);
      expect(members.activeMemberIdsExcept).not.toHaveBeenCalled();
      expect(notifications.sendNotification).not.toHaveBeenCalled();
      expect(logged).toHaveBeenCalledWith('Birthday of inactive member 5 not announced (D39).');
    });

    it('sends nothing for an owner with no auth_user row, and reports it as ok = false (§2.2)', async () => {
      members.ownerStatus.mockResolvedValue('missing');

      await expect(executer.run(LIVE_PAYLOAD)).resolves.toEqual({
        ok: false,
        detail: 'owner-missing',
      });
      expect(notifications.sendNotification).not.toHaveBeenCalled();
    });

    it('announces an active owner, reporting the delivery as before', async () => {
      await expect(executer.run(LIVE_PAYLOAD)).resolves.toEqual({ ok: true, detail: 'published' });
      expect(notifications.sendNotification).toHaveBeenCalledTimes(1);
      expect(logged).not.toHaveBeenCalled();
    });

    it('does not apply to a payment reminder, whose owner_id is a loan id', async () => {
      // Loan 412 has no auth_user row. Were D39 applied, this reminder would be dropped.
      members.ownerStatus.mockResolvedValue('missing');

      await expect(executer.run(REMINDER)).resolves.toEqual({ ok: true, detail: 'published' });
      expect(members.ownerStatus).not.toHaveBeenCalled();
      expect(notifications.sendNotification).toHaveBeenCalledWith(
        [7],
        REMINDER.message,
        REMINDER.target,
      );
    });

    it.each([null, 'Birthdate', 'birthdate '])(
      'treats type %j as not a birthday: the v1 path, with the stored list',
      async (type) => {
        await executer.run({ ...LIVE_PAYLOAD, type });

        expect(members.ownerStatus).not.toHaveBeenCalled();
        expect(notifications.sendNotification).toHaveBeenCalledWith(
          [2, 4, 3, 13, 11, 10, 1, 9, 12, 6, 7, 8],
          LIVE_PAYLOAD.message,
          '/',
        );
      },
    );
  });

  describe('D49 — birthday recipients are resolved when the greeting is sent (Q49)', () => {
    it('ignores the stored user_ids for the audience', async () => {
      members.activeMemberIdsExcept.mockResolvedValue([14]);

      await executer.run({ ...LIVE_PAYLOAD, user_ids: '[2, 3]' });

      expect(notifications.sendNotification).toHaveBeenCalledWith([14], LIVE_PAYLOAD.message, '/');
    });

    it('asks for the active members except the owner named in the payload', async () => {
      await executer.run({ ...LIVE_PAYLOAD, owner_id: '15' });

      expect(members.ownerStatus).toHaveBeenCalledWith(15);
      expect(members.activeMemberIdsExcept).toHaveBeenCalledWith(15);
    });

    it('sends to an empty list when the owner is the only active member', async () => {
      members.activeMemberIdsExcept.mockResolvedValue([]);
      notifications.sendNotification.mockResolvedValue('no-subscriptions');

      await expect(executer.run(LIVE_PAYLOAD)).resolves.toEqual({
        ok: true,
        detail: 'no-subscriptions',
      });
      expect(notifications.sendNotification).toHaveBeenCalledWith([], LIVE_PAYLOAD.message, '/');
    });

    it('leaves a payment reminder’s recipients to the stored list', async () => {
      await executer.run(REMINDER);

      expect(members.activeMemberIdsExcept).not.toHaveBeenCalled();
    });

    /** §2.3: the stored list is still parsed, so a row v1 fails on still fails, first. */
    it('still json.loads the stored user_ids of a birthday, before any member read', async () => {
      await expect(executer.run({ ...LIVE_PAYLOAD, user_ids: '[2, 3' })).rejects.toThrow(
        SyntaxError,
      );
      expect(members.ownerStatus).not.toHaveBeenCalled();
      expect(notifications.sendNotification).not.toHaveBeenCalled();
    });

    it('still raises KeyError for a birthday with no user_ids, before any member read (C23)', async () => {
      const payload = { ...LIVE_PAYLOAD };
      delete payload.user_ids;

      await expect(executer.run(payload)).rejects.toThrow("KeyError: 'user_ids'");
      expect(members.ownerStatus).not.toHaveBeenCalled();
    });

    it('reads message and target before owner_id', async () => {
      const payload = { ...LIVE_PAYLOAD };
      delete payload.target;
      delete payload.owner_id;

      await expect(executer.run(payload)).rejects.toThrow("KeyError: 'target'");
    });
  });

  describe('owner_id on a birthday task (§2.4)', () => {
    it('raises KeyError when it is absent, so the row stays unprocessed', async () => {
      const payload = { ...LIVE_PAYLOAD };
      delete payload.owner_id;

      await expect(executer.run(payload)).rejects.toThrow("KeyError: 'owner_id'");
      expect(notifications.sendNotification).not.toHaveBeenCalled();
    });

    it('raises TypeError when it is NULL', async () => {
      await expect(executer.run({ ...LIVE_PAYLOAD, owner_id: null })).rejects.toThrow(
        "scheduler payload key 'owner_id' is NULL",
      );
    });

    it.each(['', 'abc', '-5', '5.0', ' 5', '５'])('raises ValueError for %j', async (ownerId) => {
      await expect(executer.run({ ...LIVE_PAYLOAD, owner_id: ownerId })).rejects.toThrow(
        'ValueError: invalid owner_id',
      );
      expect(members.ownerStatus).not.toHaveBeenCalled();
    });

    it('reads leading zeros as decimal', async () => {
      await executer.run({ ...LIVE_PAYLOAD, owner_id: '05' });

      expect(members.ownerStatus).toHaveBeenCalledWith(5);
    });

    it('maps an id beyond integer to one no row can have, rather than an out-of-range bind', async () => {
      members.ownerStatus.mockResolvedValue('missing');

      await executer.run({ ...LIVE_PAYLOAD, owner_id: '99999999999' });

      expect(members.ownerStatus).toHaveBeenCalledWith(2147483648);
      expect(notifications.sendNotification).not.toHaveBeenCalled();
    });
  });
});
