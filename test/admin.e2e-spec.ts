import type { SendEmailCommand } from '@aws-sdk/client-ses';
import type { SendMessageCommand } from '@aws-sdk/client-sqs';
import type { INestApplication } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { Role } from '../src/auth/permissions/roles';
import { NEST_APPLICATION_OPTIONS } from '../src/bootstrap';
import { ApiExceptionFilter } from '../src/common/filters/api-exception.filter';
import { SES_CLIENT } from '../src/mail/ses.client';
import { NOTIFICATION_PUBLISH_RETRY } from '../src/notifications/notification-publisher';
import { SQS_CLIENT } from '../src/notifications/sqs.client';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  ADMIN_EMAIL,
  authHeader,
  obtainToken,
  resetDatabase,
  seedAdminUser,
  seedUser,
  type SeededUser,
} from './support/abstract-test';
import {
  REAL_APPLE_ROW,
  REAL_FCM_DECODED,
  REAL_FCM_ROW,
} from './support/push-subscription.fixture';

/**
 * Phase 8 e2e — `GET /api/admin`, the operator's self-test of the two outbound channels.
 *
 * ## ⚠️ v1 has no test for this view
 *
 * There is no `test_admin_views.py`. The cells are written from `views/admin.py` and
 * `services/admin.py`, and every outcome was measured on the pinned v1
 * (`~/.fondo-parity-harness/p8/oracle-out2.jsonl`, `oracle2-out.jsonl`, gunicorn `S9`).
 *
 * ## ⚠️ Capture stubs only
 *
 * In production this route sends a **real** email and a **real** push. Here SES and SQS are
 * replaced at the client seam (`SES_CLIENT`, `SQS_CLIENT`), so `MailService` still renders the
 * `TEST` template and `NotificationService` still reads hstore — only the wire is fake.
 */
describe('Phase 8 — /api/admin', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const ses = { send: jest.fn() };
  const sqs = { send: jest.fn() };
  let admin: SeededUser;
  let member: SeededUser;
  const tokens = new Map<Role, string>();

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(SES_CLIENT)
      .useValue(ses)
      .overrideProvider(SQS_CLIENT)
      .useValue(sqs)
      .overrideProvider(NOTIFICATION_PUBLISH_RETRY)
      .useValue({ attempts: 1, baseDelayMs: 0 })
      .compile();

    app = moduleFixture.createNestApplication(NEST_APPLICATION_OPTIONS);
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.init();
    prisma = app.get(PrismaService);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    await resetDatabase(prisma);
    admin = await seedAdminUser(prisma);
    await seedUser(prisma, {
      email: 'president@mail.com',
      identification: 1001n,
      role: Role.PRESIDENT,
    });
    await seedUser(prisma, {
      email: 'treasurer@mail.com',
      identification: 2002n,
      role: Role.TREASURER,
    });
    member = await seedUser(prisma, {
      email: 'member@mail.com',
      identification: 3003n,
      role: Role.MEMBER,
    });
    tokens.set(Role.ADMIN, await obtainToken(app, ADMIN_EMAIL));
    tokens.set(Role.PRESIDENT, await obtainToken(app, 'president@mail.com'));
    tokens.set(Role.TREASURER, await obtainToken(app, 'treasurer@mail.com'));
    tokens.set(Role.MEMBER, await obtainToken(app, 'member@mail.com'));
  });

  afterAll(async () => {
    await resetDatabase(prisma);
    await app.close();
  });

  beforeEach(async () => {
    ses.send.mockReset();
    ses.send.mockResolvedValue({ MessageId: 'ses-1' });
    sqs.send.mockReset();
    sqs.send.mockResolvedValue({ MessageId: 'sqs-1' });
    await prisma.$executeRawUnsafe('DELETE FROM fondo_api_notificationsubscriptions');
  });

  const server = (): App => app.getHttpServer();
  const asRole = (role: Role): Record<string, string> => authHeader(tokens.get(role) as string);
  const get = (path: string, role: Role = Role.ADMIN): request.Test =>
    request(server()).get(path).set(asRole(role));

  const expectBodiless = (response: request.Response, status: number): void => {
    expect(response.status).toBe(status);
    expect(response.text).toBe('');
    expect(response.headers.allow).toBe('GET, HEAD, OPTIONS');
    expect(response.headers.vary).toContain('Accept');
  };

  const expectNothingSent = (): void => {
    expect(ses.send).not.toHaveBeenCalled();
    expect(sqs.send).not.toHaveBeenCalled();
  };

  describe('the type switch — only a missing type is a 400', () => {
    it('A-missing: 400, bodiless, nothing sent', async () => {
      expectBodiless(await get('/api/admin'), 400);
      expectNothingSent();
    });

    it.each([
      ['A-empty', '/api/admin?type='],
      ['A-bare', '/api/admin?type'],
      ['A-EMAIL (case-sensitive)', '/api/admin?type=EMAIL'],
      ['A-other', '/api/admin?type=push'],
      ['A-repeat-last-other (QueryDict.get is the last value)', '/api/admin?type=email&type=x'],
    ])('%s: 200 and NOTHING is sent', async (_label, path) => {
      expectBodiless(await get(path), 200);
      expectNothingSent();
    });
  });

  describe('type=email — the TEST template, to the caller only', () => {
    it('A-email: 200, one SES send, To = the caller, no Bcc, the TEST subject', async () => {
      expectBodiless(await get('/api/admin?type=email'), 200);
      expect(ses.send).toHaveBeenCalledTimes(1);
      const { input } = (ses.send.mock.calls[0] as [SendEmailCommand])[0];
      expect(input.Destination).toEqual({ ToAddresses: [ADMIN_EMAIL], BccAddresses: [] });
      expect(input.Message?.Subject?.Data).toBe('[Fondo Montañez] Test email');
      expect(input.Message?.Body?.Html?.Data).toContain('Correo de prueba');
      expect(sqs.send).not.toHaveBeenCalled();
    });

    it('A-repeat-last-email: ?type=x&type=email sends', async () => {
      expectBodiless(await get('/api/admin?type=x&type=email'), 200);
      expect(ses.send).toHaveBeenCalledTimes(1);
    });

    it('a refused SES send is still a 200 (send_mail returns False and nobody reads it)', async () => {
      ses.send.mockRejectedValue(new Error('MessageRejected'));
      expectBodiless(await get('/api/admin?type=email'), 200);
      expect(ses.send).toHaveBeenCalledTimes(1);
    });
  });

  describe("type=notifications — the caller's subscriptions only", () => {
    it("A-notifications: 200, one SQS message carrying only the caller's subscription", async () => {
      await insertRawSubscription(prisma, admin.id, REAL_FCM_ROW);
      await insertRawSubscription(prisma, member.id, REAL_APPLE_ROW);

      expectBodiless(await get('/api/admin/?type=notifications'), 200);
      expect(sqs.send).toHaveBeenCalledTimes(1);
      const body = JSON.parse(
        (sqs.send.mock.calls[0] as [SendMessageCommand])[0].input.MessageBody as string,
      ) as unknown;
      expect(body).toEqual({
        subscriptions: [REAL_FCM_DECODED],
        message: { body: 'Test Notification', target: '/' },
      });
      expect(ses.send).not.toHaveBeenCalled();
    });

    it('a caller with no subscription: 200 and no message (send_notification returns early)', async () => {
      await insertRawSubscription(prisma, member.id, REAL_APPLE_ROW);
      expectBodiless(await get('/api/admin?type=notifications'), 200);
      expect(sqs.send).not.toHaveBeenCalled();
    });

    it('a failed SQS publish is still a 200', async () => {
      await insertRawSubscription(prisma, admin.id, REAL_FCM_ROW);
      sqs.send.mockRejectedValue(new Error('throttled'));
      expectBodiless(await get('/api/admin?type=notifications'), 200);
    });
  });

  describe('roles and methods (list_permissions AdminView: GET 0)', () => {
    it.each([
      ['A-role1-email', Role.PRESIDENT],
      ['A-role2-email', Role.TREASURER],
      ['A-role3-email', Role.MEMBER],
    ])('%s: 403 and nothing sent', async (_label, role) => {
      await insertRawSubscription(prisma, member.id, REAL_FCM_ROW);
      const response = await get('/api/admin?type=email', role);
      expect(response.status).toBe(403);
      expect(response.body).toEqual({
        detail: 'You do not have permission to perform this action.',
      });
      const notifications = await get('/api/admin?type=notifications', role);
      expect(notifications.status).toBe(403);
      expectNothingSent();
    });

    it.each([
      ['A-head-email', 'type=email'],
      ['A-head-notifications', 'type=notifications'],
    ])(
      '%s: HEAD is 403 for ADMIN and sends NOTHING — measured on v1 (no HEAD key)',
      async (_label, query) => {
        await insertRawSubscription(prisma, admin.id, REAL_FCM_ROW);
        const response = await request(server())
          .head(`/api/admin?${query}`)
          .set(asRole(Role.ADMIN));
        expect(response.status).toBe(403);
        expectNothingSent();
      },
    );

    it.each([
      ['A-post', 'post'],
      ['A-put', 'put'],
      ['A-options', 'options'],
      ['patch', 'patch'],
      ['delete', 'delete'],
    ] as const)('%s: 403 for ADMIN', async (_label, method) => {
      const response = await request(server())
        [method]('/api/admin?type=email')
        .set(asRole(Role.ADMIN));
      expect(response.status).toBe(403);
      expect(response.headers.allow).toBe('GET, HEAD, OPTIONS');
      expectNothingSent();
    });

    it('unauthenticated: 401 and nothing sent', async () => {
      await request(server()).get('/api/admin?type=email').expect(401);
      expectNothingSent();
    });
  });
});

/** Inserts a row exactly as v1 wrote it (the same helper `notification.e2e-spec.ts` uses). */
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
