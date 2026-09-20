import type { PushSubscription } from './push-subscription';
import type { NotificationPublisher } from './notification-publisher';
import { NotificationService, UNSUBSCRIBE_NOT_FOUND, UNSUBSCRIBE_OK } from './notification.service';
import type { NotificationSubscriptionRepository } from './notification-subscription.repository';
import type { SchedulerTaskRepository } from '../scheduler/scheduler-task.repository';

/**
 * `fondo_api/services/notification.py:NotificationService`, unit level.
 *
 * The subscription payload is a **real** one: it is the fixture from
 * `fondo_api/tests/test_notification_views.py:setUp`, which is itself a captured browser
 * push subscription.
 */
const SUBSCRIPTION = {
  endpoint:
    'https://fcm.googleapis.com/fcm/send/eX6bP7wJrF4:APA91bG3MLpEG28xFOuYLQc-AB78XRywxVFOtGQpGwUQp5NWc-6GYzjvgSdCIiI4U_cFsS22Qi9QPpdI3hZ1OjyO8LcAoSfmhnK31IaXJc7OhnaauHzToLZt7HpP9bZO59yIP8i5FWs5',
  expirationTime: null,
  keys: {
    p256dh:
      'BHUdL9eM2s6BoDOIl0zz68ZsPqY9wLAQC8CttBykmgZC1SU3U7wV6tKcJ4wjkj1-T_0qrsOqjzBmTcxvhUPilA4',
    auth: '60-ComhtIqES-C7GmbrDVg',
  },
};

const DECODED: PushSubscription = {
  keys: SUBSCRIPTION.keys,
  endpoint: SUBSCRIPTION.endpoint,
  expirationTime: null,
};

describe('NotificationService', () => {
  let repository: {
    existsByEndpoint: jest.Mock;
    create: jest.Mock;
    findIdByUserAndEndpoint: jest.Mock;
    deleteById: jest.Mock;
    deleteAllByUserId: jest.Mock;
    findPushSubscriptionsByUserIds: jest.Mock;
  };
  let publisher: { publish: jest.Mock };
  let schedulerTasks: {
    existsUnprocessedOnDay: jest.Mock;
    create: jest.Mock;
    deleteByOwnerAndType: jest.Mock;
  };
  let service: NotificationService;

  beforeEach(() => {
    repository = {
      existsByEndpoint: jest.fn().mockResolvedValue(false),
      create: jest.fn().mockResolvedValue(undefined),
      findIdByUserAndEndpoint: jest.fn().mockResolvedValue(null),
      deleteById: jest.fn().mockResolvedValue(undefined),
      deleteAllByUserId: jest.fn().mockResolvedValue(0),
      findPushSubscriptionsByUserIds: jest.fn().mockResolvedValue([]),
    };
    publisher = { publish: jest.fn().mockResolvedValue(true) };
    schedulerTasks = {
      existsUnprocessedOnDay: jest.fn().mockResolvedValue(false),
      create: jest.fn().mockResolvedValue(undefined),
      deleteByOwnerAndType: jest.fn().mockResolvedValue(0),
    };
    service = new NotificationService(
      repository as unknown as NotificationSubscriptionRepository,
      publisher as unknown as NotificationPublisher,
      schedulerTasks as unknown as SchedulerTaskRepository,
    );
  });

  describe('saveSubscription', () => {
    it('stores a new endpoint', async () => {
      await service.saveSubscription(7, SUBSCRIPTION);

      expect(repository.existsByEndpoint).toHaveBeenCalledWith(SUBSCRIPTION.endpoint);
      expect(repository.create).toHaveBeenCalledWith(7, SUBSCRIPTION);
    });

    it('is a silent no-op when the endpoint already exists — the browser re-registers often', async () => {
      repository.existsByEndpoint.mockResolvedValue(true);

      await service.saveSubscription(7, SUBSCRIPTION);

      expect(repository.create).not.toHaveBeenCalled();
    });

    it('dedupes across all users, not per user — v1 filters on the endpoint alone', async () => {
      await service.saveSubscription(7, SUBSCRIPTION);
      // The existence query carries no user id.
      expect(repository.existsByEndpoint).toHaveBeenCalledWith(SUBSCRIPTION.endpoint);
      expect(repository.existsByEndpoint.mock.calls[0]).toHaveLength(1);
    });

    it("500s on a body with no 'endpoint' — v1 raises KeyError", async () => {
      await expect(service.saveSubscription(7, {})).rejects.toThrow("KeyError: 'endpoint'");
      expect(repository.create).not.toHaveBeenCalled();
    });

    it.each([
      ['an array', [1, 2]],
      ['a string', 'nope'],
      ['null', null],
      ['a number', 5],
    ])('500s on %s body — v1 raises TypeError', async (_name, body) => {
      await expect(service.saveSubscription(7, body)).rejects.toThrow(TypeError);
      expect(repository.create).not.toHaveBeenCalled();
    });

    it('coerces a non-string endpoint the way HStoreField.get_prep_value does', async () => {
      await service.saveSubscription(7, { endpoint: 123 });
      expect(repository.existsByEndpoint).toHaveBeenCalledWith('123');
    });
  });

  describe('unregisterSubscription', () => {
    it('deletes the row and returns 200', async () => {
      repository.findIdByUserAndEndpoint.mockResolvedValue(42);

      await expect(service.unregisterSubscription(7, SUBSCRIPTION)).resolves.toBe(UNSUBSCRIBE_OK);
      expect(repository.findIdByUserAndEndpoint).toHaveBeenCalledWith(7, SUBSCRIPTION.endpoint);
      expect(repository.deleteById).toHaveBeenCalledWith(42);
    });

    it('returns 404 for an endpoint this user never registered', async () => {
      repository.findIdByUserAndEndpoint.mockResolvedValue(null);

      await expect(service.unregisterSubscription(7, SUBSCRIPTION)).resolves.toBe(
        UNSUBSCRIBE_NOT_FOUND,
      );
      expect(repository.deleteById).not.toHaveBeenCalled();
    });

    it('is scoped to the caller — the user id is part of the lookup', async () => {
      await service.unregisterSubscription(99, SUBSCRIPTION);
      expect(repository.findIdByUserAndEndpoint).toHaveBeenCalledWith(99, SUBSCRIPTION.endpoint);
    });
  });

  describe('removeAllSubscriptions', () => {
    it('delegates to the repository', async () => {
      await service.removeAllSubscriptions(7);
      expect(repository.deleteAllByUserId).toHaveBeenCalledWith(7);
    });
  });

  describe('sendNotification', () => {
    it('publishes { subscriptions, message: { body, target } } in that key order', async () => {
      repository.findPushSubscriptionsByUserIds.mockResolvedValue([DECODED]);

      await service.sendNotification(
        [1, 2],
        'Ha sido creada una nueva solicitud de crédito',
        '/loan/1',
      );

      expect(repository.findPushSubscriptionsByUserIds).toHaveBeenCalledWith([1, 2]);
      expect(publisher.publish).toHaveBeenCalledTimes(1);
      const calls = publisher.publish.mock.calls as unknown as [Record<string, unknown>][];
      const content = calls[0][0];
      expect(Object.keys(content)).toEqual(['subscriptions', 'message']);
      expect(Object.keys(content.message as object)).toEqual(['body', 'target']);
      expect(content).toEqual({
        subscriptions: [DECODED],
        message: {
          body: 'Ha sido creada una nueva solicitud de crédito',
          target: '/loan/1',
        },
      });
    });

    describe('condition 4 — a member with no subscriptions gets nothing', () => {
      it('returns early and publishes no message at all', async () => {
        repository.findPushSubscriptionsByUserIds.mockResolvedValue([]);

        await service.sendNotification([1], 'Recuerde que la fecha límite…', '/loan/1');

        // Carried forward knowingly (plan Phase 2, condition 4 / Q7): push only, no email
        // fallback, so this member simply receives no payment reminder.
        expect(publisher.publish).not.toHaveBeenCalled();
      });

      it('does not query at all for an empty user list', async () => {
        await service.sendNotification([], 'x', '/');
        expect(publisher.publish).not.toHaveBeenCalled();
      });
    });

    it('never throws when the publish fails — the caller’s write must stand', async () => {
      repository.findPushSubscriptionsByUserIds.mockResolvedValue([DECODED]);
      publisher.publish.mockResolvedValue(false);

      // ⚠️ Phase 7b widened the return from `void` to a `NotificationDelivery` tag. The
      // assertion this replaces was `resolves.toBeUndefined()`, whose subject was "does not
      // throw" — that is still what is asserted, now naming the outcome instead of the
      // absence of one. v1 returns `None` for all three tags; the scheduler needs to tell
      // them apart in order to log a swallowed publish failure rather than record it as a
      // success (`docs/phase-7b-deviations.md` §3).
      await expect(service.sendNotification([1], 'x', '/')).resolves.toBe('failed');
    });

    describe('the three v1 outcomes, told apart (Phase 7b)', () => {
      it('reports "published" when SQS accepted the message', async () => {
        repository.findPushSubscriptionsByUserIds.mockResolvedValue([DECODED]);
        publisher.publish.mockResolvedValue(true);

        await expect(service.sendNotification([1], 'x', '/')).resolves.toBe('published');
      });

      it('reports "no-subscriptions" when the member granted no browser permission', async () => {
        repository.findPushSubscriptionsByUserIds.mockResolvedValue([]);

        await expect(service.sendNotification([1], 'x', '/')).resolves.toBe('no-subscriptions');
      });

      it('reports "failed" when every publish attempt failed — and still does not throw', async () => {
        repository.findPushSubscriptionsByUserIds.mockResolvedValue([DECODED]);
        publisher.publish.mockResolvedValue(false);

        await expect(service.sendNotification([1], 'x', '/')).resolves.toBe('failed');
      });
    });
  });

  /**
   * `schedule_notification` / `remove_sch_notitfications` — Phase **7a**, landed here because
   * `PATCH /api/user/<id>` calls both (`services/user.py:281-282`). Review finding **S9**,
   * condition **C24**.
   */
  describe('scheduleNotification', () => {
    const payload = {
      type: 'birthdate',
      owner_id: 5,
      user_ids: [2, 4, 3],
      target: '/',
      message: 'Hoy está cumpliendo años N@CHO Montañez Herrera',
    };

    it('dedupes on (owner_id, type, local calendar day, not processed)', async () => {
      await service.scheduleNotification({ year: 2027, month: 8, day: 25 }, payload, 4);

      expect(schedulerTasks.existsUnprocessedOnDay).toHaveBeenCalledWith(
        5,
        'birthdate',
        2027,
        8,
        25,
        // No interactive-transaction client: this call is not inside one.
        undefined,
      );
    });

    it('writes the task at local midnight Bogota, i.e. 05:00Z', async () => {
      await service.scheduleNotification({ year: 2027, month: 8, day: 25 }, payload, 4);

      expect(schedulerTasks.create).toHaveBeenCalledTimes(1);
      const [runDate, written, repeat] = schedulerTasks.create.mock.calls[0] as [
        Date,
        typeof payload,
        number,
      ];
      // The live row reads `2027-08-25 05:00:00+00`.
      expect(runDate.toISOString()).toBe('2027-08-25T05:00:00.000Z');
      expect(written).toBe(payload);
      expect(repeat).toBe(4);
    });

    it('is a silent no-op when an unprocessed task already exists for that day', async () => {
      schedulerTasks.existsUnprocessedOnDay.mockResolvedValue(true);

      await service.scheduleNotification({ year: 2027, month: 8, day: 25 }, payload, 4);

      expect(schedulerTasks.create).not.toHaveBeenCalled();
    });

    it('defaults repeat to 0 (NONE), as v1 does', async () => {
      await service.scheduleNotification({ year: 2027, month: 8, day: 25 }, payload);

      const call = schedulerTasks.create.mock.calls[0] as [Date, unknown, number];
      expect(call[2]).toBe(0);
    });
  });

  describe('removeSchNotifications', () => {
    it('deletes every task for that owner and type, processed or not', async () => {
      schedulerTasks.deleteByOwnerAndType.mockResolvedValue(3);

      await expect(service.removeSchNotifications('birthdate', 5)).resolves.toBe(3);
      expect(schedulerTasks.deleteByOwnerAndType).toHaveBeenCalledWith(5, 'birthdate', undefined);
    });
  });
});
