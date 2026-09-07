import type { INestApplication } from '@nestjs/common';
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { Test, type TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { Role } from '../src/auth/permissions/roles';
import { NEST_APPLICATION_OPTIONS } from '../src/bootstrap';
import { ApiExceptionFilter } from '../src/common/filters/api-exception.filter';
import { NotificationPublisher } from '../src/notifications/notification-publisher';
import { NotificationService } from '../src/notifications/notification.service';
import { NotificationSubscriptionRepository } from '../src/notifications/notification-subscription.repository';
import { NOTIFICATION_PUBLISH_RETRY } from '../src/notifications/notification-publisher';
import { SQS_CLIENT } from '../src/notifications/sqs.client';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  authHeader,
  obtainToken,
  resetDatabase,
  seedUser,
  seedUserWithoutProfile,
  type SeededUser,
} from './support/abstract-test';
import {
  REAL_APPLE_DECODED,
  REAL_APPLE_ROW,
  REAL_FCM_DECODED,
  REAL_FCM_ROW,
  V1_TEST_SUBSCRIPTION,
  V1_TEST_SUBSCRIPTION_NOT_EXIST,
} from './support/push-subscription.fixture';

/**
 * Phase 2 e2e — `POST /api/notification/<operation>`, the hstore repository and the SQS
 * publisher.
 *
 * ## Ported from v1
 *
 * `fondo_api/tests/test_notification_views.py` has four running methods, all reproduced:
 * `test_subscribe`, `test_unsubscribe`, `test_unsubscribe_not_found`, `test_invalid_operation`.
 * Its fifth, `pending_test_send_notification`, is prefixed `pending_` and **never runs** in
 * v1 — it patches `requests.post`, which is dead code from the pre-SQS design. It is not
 * revived as-is; the behaviour it gestured at (send with a real subscription in the table)
 * is covered properly under *send_notification* below, against the SQS boundary v1 actually
 * uses.
 *
 * ## Why this file is longer than the four ported tests
 *
 * Plan §Phase 2: *"hstore + thin coverage. Only 4 v1 notification tests exist and this is
 * raw-SQL territory. **Extra integration tests required** covering the round-trip of a real
 * push-subscription payload, including the nested `keys` repair."* The extra groups are
 * *hstore round-trip*, *send_notification* and *the guard runs before the parser*.
 */
describe('Phase 2 — notifications', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let repository: NotificationSubscriptionRepository;
  let notifications: NotificationService;
  let member: SeededUser;
  let other: SeededUser;
  let token: string;
  let otherToken: string;
  const sqs = { send: jest.fn() };

  async function countSubscriptions(): Promise<number> {
    const rows = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
      'SELECT count(*) AS count FROM fondo_api_notificationsubscriptions',
    );
    return Number(rows[0].count);
  }

  function subscribe(body: unknown, as: string = token): request.Test {
    return request(app.getHttpServer())
      .post('/api/notification/subscribe')
      .set(authHeader(as))
      .send(body as object);
  }

  function unsubscribe(body: unknown, as: string = token): request.Test {
    return request(app.getHttpServer())
      .post('/api/notification/unsubscribe')
      .set(authHeader(as))
      .send(body as object);
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      // v1's tests patch `boto3.client`; this is the same seam.
      .overrideProvider(SQS_CLIENT)
      .useValue(sqs)
      // Keep the retry policy but drop the sleeps, so a failure case costs no wall clock.
      .overrideProvider(NOTIFICATION_PUBLISH_RETRY)
      .useValue({ attempts: 3, baseDelayMs: 0 })
      .compile();

    app = moduleFixture.createNestApplication(NEST_APPLICATION_OPTIONS);
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.init();

    prisma = app.get(PrismaService);
    repository = app.get(NotificationSubscriptionRepository);
    notifications = app.get(NotificationService);
    jest
      .spyOn(app.get(NotificationPublisher)['logger'], 'error')
      .mockImplementation(() => undefined);
    jest.spyOn(app.get(NotificationPublisher)['logger'], 'log').mockImplementation(() => undefined);

    await resetDatabase(prisma);
    // `AbstractTest.create_user()` seeds one ADMIN; this suite needs an ordinary member too,
    // because NotificationView's rule is `POST: 3` — every role may subscribe.
    member = await seedUser(prisma, {
      email: 'mail_for_tests@mail.com',
      identification: 99999n,
      role: Role.ADMIN,
    });
    other = await seedUser(prisma, {
      email: 'other@mail.com',
      identification: 1001n,
      role: Role.MEMBER,
    });
    token = await obtainToken(app, member.email);
    otherToken = await obtainToken(app, other.email);
  });

  beforeEach(async () => {
    sqs.send.mockReset();
    sqs.send.mockResolvedValue({ MessageId: 'msg-1' });
    await prisma.$executeRawUnsafe('DELETE FROM fondo_api_notificationsubscriptions');
  });

  afterAll(async () => {
    await resetDatabase(prisma);
    await app.close();
  });

  // -------------------------------------------------------------------------
  // v1: fondo_api/tests/test_notification_views.py
  // -------------------------------------------------------------------------

  describe('ported from test_notification_views.py', () => {
    it('test_subscribe', async () => {
      const response = await subscribe(V1_TEST_SUBSCRIPTION);

      expect(response.status).toBe(200);
      // `Response(status=HTTP_200_OK)` — DRF renders zero bytes.
      expect(response.text).toBe('');
      expect(await countSubscriptions()).toBe(1);
    });

    it('test_unsubscribe', async () => {
      await subscribe(V1_TEST_SUBSCRIPTION).expect(200);

      const response = await unsubscribe(V1_TEST_SUBSCRIPTION);

      expect(response.status).toBe(200);
      expect(response.text).toBe('');
      expect(await countSubscriptions()).toBe(0);
    });

    it('test_unsubscribe_not_found', async () => {
      await subscribe(V1_TEST_SUBSCRIPTION).expect(200);

      const response = await unsubscribe(V1_TEST_SUBSCRIPTION_NOT_EXIST);

      expect(response.status).toBe(404);
      expect(response.text).toBe('');
      expect(await countSubscriptions()).toBe(1);
    });

    it('test_invalid_operation', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/notification/suscribe')
        .set(authHeader(token))
        .send(V1_TEST_SUBSCRIPTION);

      // v1's view falls through to `Response(status=HTTP_405_METHOD_NOT_ALLOWED)`, which is
      // a *view*-level 405 with an empty body — not DRF's `{"detail": …}` envelope.
      expect(response.status).toBe(405);
      expect(response.text).toBe('');
      expect(await countSubscriptions()).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Subscription behaviour v1 has no test for
  // -------------------------------------------------------------------------

  describe('subscription storage', () => {
    it('does not duplicate a re-subscribed endpoint — the browser re-registers often', async () => {
      await subscribe(V1_TEST_SUBSCRIPTION).expect(200);
      await subscribe(V1_TEST_SUBSCRIPTION).expect(200);
      await subscribe(V1_TEST_SUBSCRIPTION).expect(200);

      expect(await countSubscriptions()).toBe(1);
    });

    it('dedupes across users, not per user — v1 filters on the endpoint alone', async () => {
      await subscribe(V1_TEST_SUBSCRIPTION).expect(200);
      await subscribe(V1_TEST_SUBSCRIPTION, otherToken).expect(200);

      expect(await countSubscriptions()).toBe(1);
      const rows = await prisma.$queryRawUnsafe<{ user_id: number }[]>(
        'SELECT user_id FROM fondo_api_notificationsubscriptions',
      );
      // The row stays with the member who registered it first.
      expect(rows[0].user_id).toBe(member.id);
    });

    it('unsubscribe is scoped to the caller', async () => {
      await subscribe(V1_TEST_SUBSCRIPTION).expect(200);

      await unsubscribe(V1_TEST_SUBSCRIPTION, otherToken).expect(404);

      expect(await countSubscriptions()).toBe(1);
    });

    /**
     * ⚠️ **P2-D4 corrected** (parity finding F5). `remove_all_subscriptions` is *not* dead in
     * v1: `services/user.py:218` calls it from `__update_user_preferences` when a member
     * switches notifications off —
     *
     * ```python
     * if remove_notifications and not user_preference.notifications:
     *     self.__notification_service.remove_all_subscriptions(id)
     * ```
     *
     * — so turning notifications off deletes every push subscription that member owns, on
     * every device. Phase 2 ships no route that reaches it (`PATCH /api/user/<id>` is Phase
     * 3), so it is exercised here against the real table instead, both to prove the SQL and
     * so Phase 3 only has to wire the call.
     */
    it('remove_all_subscriptions deletes every row of one user and no one else’s', async () => {
      await subscribe(V1_TEST_SUBSCRIPTION).expect(200);
      await subscribe({
        ...V1_TEST_SUBSCRIPTION,
        endpoint: `${V1_TEST_SUBSCRIPTION.endpoint}-second-device`,
      }).expect(200);
      await subscribe(
        { ...V1_TEST_SUBSCRIPTION, endpoint: `${V1_TEST_SUBSCRIPTION.endpoint}-other-member` },
        otherToken,
      ).expect(200);
      expect(await countSubscriptions()).toBe(3);

      await notifications.removeAllSubscriptions(member.id);

      const rows = await prisma.$queryRawUnsafe<{ user_id: number }[]>(
        'SELECT user_id FROM fondo_api_notificationsubscriptions',
      );
      expect(rows).toEqual([{ user_id: other.id }]);
    });

    it('remove_all_subscriptions on a user with no rows is a no-op, not an error', async () => {
      await subscribe(V1_TEST_SUBSCRIPTION).expect(200);

      await expect(notifications.removeAllSubscriptions(other.id)).resolves.toBeUndefined();

      expect(await countSubscriptions()).toBe(1);
    });

    it("500s on a body with no 'endpoint' — v1 raises an uncaught KeyError", async () => {
      const response = await subscribe({ keys: {} });

      expect(response.status).toBe(500);
      expect(await countSubscriptions()).toBe(0);
    });

    it('stores an unregistered subscription with extra keys as sent', async () => {
      await subscribe({ ...V1_TEST_SUBSCRIPTION, extra: 'value' }).expect(200);

      const rows = await prisma.$queryRawUnsafe<{ id: number }[]>(
        'SELECT id FROM fondo_api_notificationsubscriptions',
      );
      const raw = await repository.findRawSubscriptionById(rows[0].id);
      expect(raw).toContain('"extra"=>"value"');
    });
  });

  // -------------------------------------------------------------------------
  // The extra integration coverage the plan requires for raw-SQL hstore
  // -------------------------------------------------------------------------

  describe('hstore round-trip', () => {
    it('writes the Python repr of the nested keys object, exactly as Django does', async () => {
      await subscribe(V1_TEST_SUBSCRIPTION).expect(200);

      const rows = await prisma.$queryRawUnsafe<{ id: number }[]>(
        'SELECT id FROM fondo_api_notificationsubscriptions',
      );
      const raw = await repository.findRawSubscriptionById(rows[0].id);

      // Single quotes, `', '` separators, key order preserved — NOT JSON.
      expect(raw).toContain(
        `"keys"=>"{'p256dh': '${V1_TEST_SUBSCRIPTION.keys.p256dh}', 'auth': '${V1_TEST_SUBSCRIPTION.keys.auth}'}"`,
      );
      // `expirationTime: None` is SQL NULL, not the string 'None'.
      expect(raw).toContain('"expirationTime"=>NULL');
    });

    it('reads back a v1-written row, repairing the repr into an object', async () => {
      // Written the way v1 wrote rows 160 and 1398 of `fondodev`, not the way v2 writes.
      const id = await insertRawSubscription(prisma, member.id, REAL_FCM_ROW);

      const [decoded] = await repository.findPushSubscriptionsByUserIds([member.id]);

      expect(decoded).toEqual(REAL_FCM_DECODED);
      // The repaired `keys` is a real object, not the string it was stored as.
      expect(typeof decoded.keys).toBe('object');
      expect(await repository.findRawSubscriptionById(id)).toBe(REAL_FCM_ROW);
    });

    it('survives the one live row that has no expirationTime key at all', async () => {
      await insertRawSubscription(prisma, member.id, REAL_APPLE_ROW);

      const [decoded] = await repository.findPushSubscriptionsByUserIds([member.id]);

      expect(decoded).toEqual(REAL_APPLE_DECODED);
      expect('expirationTime' in decoded).toBe(false);
    });

    it('preserves PostgreSQL key order — keys, endpoint, expirationTime', async () => {
      await subscribe(V1_TEST_SUBSCRIPTION).expect(200);

      const [decoded] = await repository.findPushSubscriptionsByUserIds([member.id]);

      // Ordered by (length, bytes): 4 < 8 < 14. This order lands in the SQS body verbatim.
      expect(Object.keys(decoded)).toEqual(['keys', 'endpoint', 'expirationTime']);
    });

    it('a v2-written row decodes identically to a v1-written one', async () => {
      // The point of the write-side Python encoding: v1 still runs until cutover and both
      // apps read the same table.
      await subscribe(REAL_FCM_DECODED).expect(200);
      const written = await prisma.$queryRawUnsafe<{ id: number }[]>(
        'SELECT id FROM fondo_api_notificationsubscriptions',
      );

      expect(await repository.findRawSubscriptionById(written[0].id)).toBe(REAL_FCM_ROW);
    });

    /**
     * Reads **all 94 real rows** of the shared dev database, when one is pointed at.
     * Skipped by default so the suite stays hermetic; `manual-tester` runs it with
     *
     * ```
     * FONDODEV_DATABASE_URL=postgresql://fondouser:fondo@localhost:5432/fondodev npm run test:e2e
     * ```
     *
     * It is strictly read-only — no writes, no truncation, no schema change.
     */
    const liveUrl = process.env.FONDODEV_DATABASE_URL;
    (liveUrl === undefined ? it.skip : it)(
      'decodes every live subscription row in fondodev',
      async () => {
        const { PrismaPg } = await import('@prisma/adapter-pg');
        const { PrismaClient } = await import('../src/prisma/prisma-client');
        const live = new PrismaClient({ adapter: new PrismaPg({ connectionString: liveUrl }) });
        try {
          const rows = await live.$queryRawUnsafe<{ id: number; subscription: string }[]>(
            'SELECT id, subscription::text AS subscription FROM fondo_api_notificationsubscriptions ORDER BY id',
          );
          expect(rows.length).toBeGreaterThan(0);

          const { decodePushSubscription, parseHstore } =
            await import('../src/common/utils/hstore.codec');
          for (const row of rows) {
            const decoded = decodePushSubscription(parseHstore(row.subscription));
            expect(typeof decoded.endpoint).toBe('string');
            expect(typeof decoded.keys).toBe('object');
            expect(typeof decoded.keys.auth).toBe('string');
            expect(typeof decoded.keys.p256dh).toBe('string');
          }
        } finally {
          await live.$disconnect();
        }
      },
    );
  });

  // -------------------------------------------------------------------------
  // send_notification -> SQS
  // -------------------------------------------------------------------------

  describe('send_notification', () => {
    function sentBody(): string {
      expect(sqs.send).toHaveBeenCalledTimes(1);
      const calls = sqs.send.mock.calls as unknown as [SendMessageCommand][];
      const command = calls[0][0];
      return command.input.MessageBody as string;
    }

    it('publishes a json.dumps-identical body for a real subscription', async () => {
      await insertRawSubscription(prisma, member.id, REAL_FCM_ROW);

      await notifications.sendNotification(
        [member.id],
        'Ha sido creada una nueva solicitud de crédito',
        '/loan/1',
      );

      const body = sentBody();
      // Separators are `', '` / `': '` and the accent is `é` — CPython, not JS.
      expect(body).toBe(
        `{"subscriptions": [{"keys": {"p256dh": "${REAL_FCM_DECODED.keys.p256dh}", "auth": ` +
          `"${REAL_FCM_DECODED.keys.auth}"}, "endpoint": "${REAL_FCM_DECODED.endpoint}", ` +
          '"expirationTime": null}], "message": {"body": "Ha sido creada una nueva solicitud ' +
          'de cr\\u00e9dito", "target": "/loan/1"}}',
      );
      // Round-trips as JSON, so the Lambda still parses it.
      expect(JSON.parse(body)).toEqual({
        subscriptions: [REAL_FCM_DECODED],
        message: { body: 'Ha sido creada una nueva solicitud de crédito', target: '/loan/1' },
      });
    });

    it('collects every subscription of every listed user into one message', async () => {
      await insertRawSubscription(prisma, member.id, REAL_FCM_ROW);
      await insertRawSubscription(prisma, other.id, REAL_APPLE_ROW);

      await notifications.sendNotification([member.id, other.id], 'x', '/');

      const content = JSON.parse(sentBody()) as { subscriptions: unknown[] };
      expect(content.subscriptions).toHaveLength(2);
    });

    it('condition 4 — a member with no subscriptions gets no message at all', async () => {
      await notifications.sendNotification([member.id], 'Recuerde que la fecha límite…', '/loan/1');

      expect(sqs.send).not.toHaveBeenCalled();
    });

    it('condition 2 — a failed publish does not surface to the caller', async () => {
      await insertRawSubscription(prisma, member.id, REAL_FCM_ROW);
      sqs.send.mockRejectedValue(new Error('SQS is down'));

      // ⚠️ Phase 7b: the return widened from `void` to a `NotificationDelivery` tag. The
      // subject of this cell is unchanged — the failure does not surface as a throw — but it
      // now also pins *which* outcome the caller is told about, which is what lets the
      // scheduler log a swallowed publish instead of recording it as a success.
      await expect(notifications.sendNotification([member.id], 'x', '/')).resolves.toBe('failed');
      // condition 1 — bounded retry, 3 attempts.
      expect(sqs.send).toHaveBeenCalledTimes(3);
    });
  });

  // -------------------------------------------------------------------------
  // Permissions and the request pipeline
  // -------------------------------------------------------------------------

  describe('permissions', () => {
    it('401s without a token', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/notification/subscribe')
        .send(V1_TEST_SUBSCRIPTION);

      expect(response.status).toBe(401);
      expect(response.body).toEqual({ detail: 'Authentication credentials were not provided.' });
      expect(response.headers['www-authenticate']).toBe('Token');
    });

    it.each(['get', 'put', 'patch', 'delete'] as const)(
      '403s on %s — NotificationView declares only POST, so the lookup misses and denies',
      async (method) => {
        const response = await request(app.getHttpServer())
          [method]('/api/notification/subscribe')
          .set(authHeader(token));

        // v1: `list_permissions['NotificationView']['GET']` -> KeyError -> `except: return False`.
        // The 403 comes from `initial()`, before dispatch could raise MethodNotAllowed, so a
        // 405 is unreachable on this route. In Nest the @All() fallback exists purely so the
        // router does not 404 before the guard runs.
        expect(response.status).toBe(403);
        expect(response.body).toEqual({
          detail: 'You do not have permission to perform this action.',
        });
      },
    );

    it('403s on OPTIONS too — v1 permission-checks it like any other method', async () => {
      const response = await request(app.getHttpServer())
        .options('/api/notification/subscribe')
        .set(authHeader(token));

      expect(response.status).toBe(403);
    });

    it('serves the optional trailing slash, as v1’s /?$ regex does', async () => {
      await request(app.getHttpServer())
        .post('/api/notification/subscribe/')
        .set(authHeader(token))
        .send(V1_TEST_SUBSCRIPTION)
        .expect(200);
    });
  });

  /**
   * Review condition **C13** — nothing previously proved that a permission denial precedes
   * request parsing on a *guarded* route. `role-matrix.e2e-spec.ts` sends no bodies and
   * `/api-token-auth` is `@Public()`, so only the 401 ordering was covered.
   *
   * DRF's order (`rest_framework/views.py::dispatch`) is
   * `perform_authentication` → `check_permissions` → handler → `request.data`, so a caller
   * who may not perform the action gets a **403 even when the body would have been a 415**.
   * Phases 3–8 depend on this: a MEMBER `PATCH`ing `/api/loan` with a malformed body must be
   * told 403, not handed a parser error that leaks which media types the route accepts.
   */
  describe('C13 — the guard runs before the parser', () => {
    let orphanKey: string;

    beforeAll(async () => {
      // A user with no `fondo_api_userprofile` row: `request.user.userprofile` raises in v1,
      // the bare `except` returns False, and every route 403s for them — including this one,
      // whose rule (`POST: 3`) otherwise admits every role.
      const orphanId = await seedUserWithoutProfile(prisma, 'notification-orphan@mail.com');
      orphanKey = 'd'.repeat(40);
      await prisma.authToken.create({
        data: { key: orphanKey, user_id: orphanId, created: new Date() },
      });
    });

    it('403s a denied caller whose body would otherwise be a 415', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/notification/subscribe')
        .set(authHeader(orphanKey))
        .set('Content-Type', 'text/plain')
        .send('not json at all');

      expect(response.status).toBe(403);
      expect(response.body).toEqual({
        detail: 'You do not have permission to perform this action.',
      });
    });

    it('403s a denied caller whose body would otherwise be a 400 parse error', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/notification/subscribe')
        .set(authHeader(orphanKey))
        .set('Content-Type', 'application/json')
        .send('{');

      expect(response.status).toBe(403);
    });

    it('positive control — the same requests really would 415 / 400 for an allowed caller', async () => {
      const unsupported = await request(app.getHttpServer())
        .post('/api/notification/subscribe')
        .set(authHeader(token))
        .set('Content-Type', 'text/plain')
        .send('not json at all');
      expect(unsupported.status).toBe(415);
      expect(unsupported.body).toEqual({
        detail: 'Unsupported media type "text/plain" in request.',
      });

      const malformed = await request(app.getHttpServer())
        .post('/api/notification/subscribe')
        .set(authHeader(token))
        .set('Content-Type', 'application/json')
        .send('{');
      expect(malformed.status).toBe(400);
      expect(malformed.body).toEqual({
        detail:
          'JSON parse error - Expecting property name enclosed in double quotes: line 1 column 2 (char 1)',
      });
    });
  });
});

/** Inserts a row exactly as v1 wrote it, bypassing v2's encoder. */
async function insertRawSubscription(
  prisma: PrismaService,
  userId: number,
  hstoreText: string,
): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<{ id: number }[]>(
    'INSERT INTO fondo_api_notificationsubscriptions (user_id, subscription) ' +
      'VALUES ($1, $2::hstore) RETURNING id',
    userId,
    hstoreText,
  );
  return rows[0].id;
}
