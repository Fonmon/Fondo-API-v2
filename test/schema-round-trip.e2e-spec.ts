import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '../src/prisma/prisma-client';
import {
  decodePushSubscription,
  decodeSchedulerPayload,
  parseHstore,
  toHstoreLiteral,
} from '../src/common/utils/hstore.codec';
import { TEST_DATABASE_URL } from './test-database';

/**
 * **Phase 0 gate, criterion 1: "every table round-trips through Prisma."**
 *
 * Each Django-created table is written and read back through the mapped Prisma model, on a
 * database provisioned from the Prisma baseline. This proves three things at once:
 *   - `schema.prisma` maps every column, name and type correctly;
 *   - the baseline migration reproduces the Django schema well enough to run against;
 *   - the two `Unsupported("hstore")` columns are reachable through raw SQL + the codec.
 *
 * The whole suite runs inside one interactive transaction that is rolled back, so the test
 * database is left as it was found (bar sequence advancement).
 */
describe('Prisma schema round-trip against the Django-created schema', () => {
  let prisma: PrismaClient;

  const NOW = new Date('2022-03-13T17:25:00.000Z');
  const DATE_ONLY = new Date(Date.UTC(2022, 2, 13));

  beforeAll(() => {
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: TEST_DATABASE_URL }),
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  /**
   * Runs `body` inside a transaction that is always rolled back.
   * Prisma has no explicit rollback API for interactive transactions, so we throw a
   * sentinel and swallow it.
   */
  async function inRollback(body: (tx: Prisma.TransactionClient) => Promise<void>): Promise<void> {
    const sentinel = new Error('__rollback__');
    try {
      await prisma.$transaction(async (tx) => {
        await body(tx);
        throw sentinel;
      });
    } catch (error) {
      if (error !== sentinel) {
        throw error;
      }
    }
  }

  interface SeededUser {
    authUser: { id: number; email: string };
    profile: { user_ptr_id: number; role: number };
  }

  /** Creates the `auth_user` + `fondo_api_userprofile` pair Django's MTI requires. */
  async function createUser(
    tx: Prisma.TransactionClient,
    overrides: { email?: string; identification?: bigint; role?: number } = {},
  ): Promise<SeededUser> {
    const email = overrides.email ?? `round.trip.${Date.now()}.${Math.random()}@example.com`;
    const authUser = await tx.authUser.create({
      data: {
        password: 'pbkdf2_sha256$150000$abc$def=',
        // `username = email` everywhere — v1 sets USERNAME_FIELD='email' but still fills
        // `username`.
        username: email,
        first_name: 'Foo Name',
        last_name: 'Foo Last Name',
        email,
        is_superuser: false,
        is_staff: false,
        is_active: true,
        // Django sets date_joined in Python; there is no DB default.
        date_joined: NOW,
      },
    });
    const profile = await tx.userProfile.create({
      data: {
        user_ptr_id: authUser.id,
        identification:
          overrides.identification ?? BigInt(Date.now()) + BigInt(Math.floor(Math.random() * 1000)),
        role: overrides.role ?? 3,
        key_activation: 'a'.repeat(50),
        birthdate: DATE_ONLY,
      },
    });
    return { authUser, profile };
  }

  it('round-trips auth_user + fondo_api_userprofile as a 1:1 (Django MTI)', async () => {
    await inRollback(async (tx) => {
      const { authUser, profile } = await createUser(tx, { role: 0 });

      expect(profile.user_ptr_id).toBe(authUser.id);

      const joined = await tx.userProfile.findUniqueOrThrow({
        where: { user_ptr_id: profile.user_ptr_id },
        include: { auth_user: true },
      });
      expect(joined.auth_user.email).toBe(authUser.email);
      expect(joined.auth_user.username).toBe(joined.auth_user.email);
      expect(joined.role).toBe(0);
      expect(typeof joined.identification).toBe('bigint');

      // ... and back the other way, which is how the auth guard will read it.
      const reverse = await tx.authUser.findUniqueOrThrow({
        where: { id: authUser.id },
        include: { profile: true },
      });
      expect(reverse.profile?.role).toBe(0);
    });
  });

  it('round-trips authtoken_token, keyed by the 40-char token string', async () => {
    await inRollback(async (tx) => {
      const { authUser } = await createUser(tx);
      const key = 'a1b2c3d4e5'.repeat(4);
      await tx.authToken.create({
        data: { key, created: NOW, user_id: authUser.id },
      });

      const found = await tx.authToken.findUniqueOrThrow({
        where: { key },
        include: { user: { include: { profile: true } } },
      });
      expect(found.key).toHaveLength(40);
      expect(found.user.id).toBe(authUser.id);
      expect(found.user.profile?.role).toBe(3);
    });
  });

  it('round-trips fondo_api_userfinance and fondo_api_userpreference', async () => {
    await inRollback(async (tx) => {
      const { profile } = await createUser(tx);

      const finance = await tx.userFinance.create({
        data: {
          contributions: 2000n,
          balance_contributions: 2000n,
          total_quota: 1000n,
          utilized_quota: 0n,
          available_quota: 500n,
          // `auto_now` is application-set in Django; there is no DB default.
          last_modified: DATE_ONLY,
          user_id: profile.user_ptr_id,
        },
      });
      expect(finance.available_quota).toBe(500n);

      const preference = await tx.userPreference.create({
        data: {
          notifications: false,
          primary_color: '#800000',
          secondary_color: '#c83737',
          user_id: profile.user_ptr_id,
        },
      });
      expect(preference.primary_color).toBe('#800000');

      const reread = await tx.userProfile.findUniqueOrThrow({
        where: { user_ptr_id: profile.user_ptr_id },
        include: { finances: true, preferences: true },
      });
      expect(reread.finances).toHaveLength(1);
      expect(reread.preferences).toHaveLength(1);
    });
  });

  it('round-trips fondo_api_loan, keeping rate as an exact Decimal(5,3)', async () => {
    await inRollback(async (tx) => {
      const { profile } = await createUser(tx);
      const loan = await tx.loan.create({
        data: {
          value: 200n,
          timelimit: 10,
          disbursement_date: new Date(Date.UTC(2017, 10, 9)),
          payment: 1,
          created_at: NOW,
          fee: 0,
          comments: '',
          state: 0,
          rate: new Prisma.Decimal('0.020'),
          user_id: profile.user_ptr_id,
          disbursement_value: 205n,
        },
      });

      const found = await tx.loan.findUniqueOrThrow({ where: { id: loan.id } });
      expect(found.rate.toString()).toBe('0.02');
      expect(found.rate.toFixed(3)).toBe('0.020');
      expect(found.value).toBe(200n);
      expect(found.disbursement_value).toBe(205n);
      expect(found.prev_loan_id).toBeNull();
      expect(found.refinanced_loan).toBeNull();
    });
  });

  it('round-trips a refinance chain through the self-referencing prev_loan FK', async () => {
    await inRollback(async (tx) => {
      const { profile } = await createUser(tx);
      const base = {
        value: 100n,
        timelimit: 5,
        disbursement_date: new Date(Date.UTC(2017, 11, 9)),
        payment: 0,
        created_at: NOW,
        fee: 0,
        state: 1,
        rate: new Prisma.Decimal('0.015'),
        user_id: profile.user_ptr_id,
      };
      const original = await tx.loan.create({ data: base });
      const refinanced = await tx.loan.create({
        data: { ...base, payment: 2, prev_loan_id: original.id },
      });
      // `refinanced_loan` is a bare BigInt in v1, not a real FK.
      await tx.loan.update({
        where: { id: original.id },
        data: { refinanced_loan: BigInt(refinanced.id) },
      });

      const reread = await tx.loan.findUniqueOrThrow({
        where: { id: refinanced.id },
        include: { prev_loan: true },
      });
      expect(reread.prev_loan?.id).toBe(original.id);
      expect(reread.prev_loan?.refinanced_loan).toBe(BigInt(refinanced.id));
    });
  });

  it('round-trips fondo_api_loandetail', async () => {
    await inRollback(async (tx) => {
      const { profile } = await createUser(tx);
      const loan = await tx.loan.create({
        data: {
          value: 200n,
          timelimit: 10,
          disbursement_date: new Date(Date.UTC(2017, 10, 9)),
          payment: 1,
          created_at: NOW,
          fee: 0,
          state: 1,
          rate: new Prisma.Decimal('0.020'),
          user_id: profile.user_ptr_id,
        },
      });
      const detail = await tx.loanDetail.create({
        data: {
          total_payment: 222n,
          minimum_payment: 24n,
          payday_limit: new Date(Date.UTC(2017, 11, 9)),
          interests: 4n,
          capital_balance: 200n,
          from_date: new Date(Date.UTC(2017, 10, 9)),
          loan_id: loan.id,
        },
      });
      const found = await tx.loanDetail.findUniqueOrThrow({
        where: { id: detail.id },
        include: { loan: true },
      });
      expect(found.total_payment).toBe(222n);
      expect(found.loan.id).toBe(loan.id);
    });
  });

  it('round-trips fondo_api_activityyear, fondo_api_activity and fondo_api_activityuser', async () => {
    await inRollback(async (tx) => {
      const { profile } = await createUser(tx);
      const year = await tx.activityYear.create({
        data: { year: BigInt(1900 + Math.floor(Math.random() * 90)), enable: true },
      });
      const activity = await tx.activity.create({
        data: { name: 'Asamblea', value: 50000n, date: DATE_ONLY, year_id: year.id },
      });
      await tx.activityUser.create({
        data: { state: 0, activity_id: activity.id, user_id: profile.user_ptr_id },
      });

      const found = await tx.activity.findUniqueOrThrow({
        where: { id: activity.id },
        include: { year: true, users: { include: { user: true } } },
      });
      expect(found.year.enable).toBe(true);
      expect(found.users).toHaveLength(1);
      expect(found.users[0]?.state).toBe(0);
      expect(found.users[0]?.user.user_ptr_id).toBe(profile.user_ptr_id);
    });
  });

  it('round-trips fondo_api_power with its two FKs to the same table', async () => {
    await inRollback(async (tx) => {
      const requester = await createUser(tx);
      const requestee = await createUser(tx);
      const power = await tx.power.create({
        data: {
          meeting_date: DATE_ONLY,
          state: 0,
          requester_id: requester.profile.user_ptr_id,
          requestee_id: requestee.profile.user_ptr_id,
        },
      });
      const found = await tx.power.findUniqueOrThrow({
        where: { id: power.id },
        include: { requester: true, requestee: true },
      });
      expect(found.requester.user_ptr_id).toBe(requester.profile.user_ptr_id);
      expect(found.requestee.user_ptr_id).toBe(requestee.profile.user_ptr_id);
    });
  });

  it('round-trips fondo_api_savingaccount', async () => {
    await inRollback(async (tx) => {
      const { profile } = await createUser(tx);
      const account = await tx.savingAccount.create({
        data: {
          created_at: NOW,
          end_date: DATE_ONLY,
          state: 0,
          value: 0n,
          user_id: profile.user_ptr_id,
        },
      });
      const found = await tx.savingAccount.findUniqueOrThrow({ where: { id: account.id } });
      // create_account sets only end_date + user: a CAP starts empty and ACTIVE.
      expect(found.value).toBe(0n);
      expect(found.state).toBe(0);
    });
  });

  it('round-trips fondo_api_file', async () => {
    await inRollback(async (tx) => {
      const file = await tx.file.create({
        data: {
          type: 0,
          display_name: `Acta ${Date.now()}-${Math.random()}`,
          created_at: NOW,
        },
      });
      const found = await tx.file.findUniqueOrThrow({ where: { id: file.id } });
      expect(found.type).toBe(0);
    });
  });

  it('reads and writes the hstore column on fondo_api_notificationsubscriptions', async () => {
    await inRollback(async (tx) => {
      const { profile } = await createUser(tx);
      const subscription = {
        endpoint: 'https://fcm.googleapis.com/fcm/send/round-trip-test',
        expirationTime: null,
        keys: { p256dh: 'BHUdL9eM2s6BoDOIl0zz', auth: '60-ComhtIqES' },
      };

      // Prisma Client cannot write Unsupported("hstore"); this is the raw-SQL path the two
      // repositories will use.
      const inserted = await tx.$queryRaw<{ id: number }[]>`
        INSERT INTO fondo_api_notificationsubscriptions (user_id, subscription)
        VALUES (${profile.user_ptr_id}, ${toHstoreLiteral(subscription)}::hstore)
        RETURNING id
      `;
      const id = inserted[0]?.id;

      const rows = await tx.$queryRaw<{ id: number; user_id: number; subscription: string }[]>`
        SELECT id, user_id, subscription::text AS subscription
        FROM fondo_api_notificationsubscriptions
        WHERE id = ${id}
      `;
      expect(rows).toHaveLength(1);
      const decoded = decodePushSubscription(parseHstore(rows[0]?.subscription));
      expect(decoded.endpoint).toBe(subscription.endpoint);
      expect(decoded.expirationTime).toBeNull();
      expect(decoded.keys).toEqual(subscription.keys);

      // The nested keys object really is stored as a Python repr, not as JSON.
      expect(rows[0]?.subscription).toContain("{'p256dh': 'BHUdL9eM2s6BoDOIl0zz'");

      // And the `subscription -> 'endpoint'` lookup v1's dedupe relies on still works.
      const byEndpoint = await tx.$queryRaw<{ count: bigint }[]>`
        SELECT count(*) AS count FROM fondo_api_notificationsubscriptions
        WHERE subscription -> 'endpoint' = ${subscription.endpoint}
      `;
      expect(Number(byEndpoint[0]?.count)).toBe(1);
    });
  });

  it('reads and writes the hstore column on fondo_api_schedulertask', async () => {
    await inRollback(async (tx) => {
      const payload = {
        type: 'payment_reminder',
        owner_id: 53,
        user_ids: [5],
        target: '/loan/53',
        message: 'Recuerde que la fecha límite de pago para el crédito 53, es el: 9 sept. 2099',
      };
      const inserted = await tx.$queryRaw<{ id: number }[]>`
        INSERT INTO fondo_api_schedulertask (type, run_date, payload, processed, repeat)
        VALUES (0, ${NOW}, ${toHstoreLiteral(payload)}::hstore, false, 0)
        RETURNING id
      `;
      const id = inserted[0]?.id;

      const rows = await tx.$queryRaw<{ payload: string; processed: boolean; repeat: number }[]>`
        SELECT payload::text AS payload, processed, repeat
        FROM fondo_api_schedulertask WHERE id = ${id}
      `;
      const decoded = decodeSchedulerPayload(parseHstore(rows[0]?.payload));
      expect(decoded.user_ids).toEqual([5]);
      expect(decoded.owner_id).toBe('53');
      expect(decoded.message).toBe(payload.message);
      expect(rows[0]?.processed).toBe(false);

      // The dedupe query in schedule_notification: payload -> 'owner_id' compared as text.
      const deduped = await tx.$queryRaw<{ count: bigint }[]>`
        SELECT count(*) AS count FROM fondo_api_schedulertask
        WHERE payload -> 'owner_id' = '53' AND payload -> 'type' = 'payment_reminder'
          AND processed = false AND id = ${id}
      `;
      expect(Number(deduped[0]?.count)).toBe(1);
    });
  });

  it('exposes the Django auth/contrib tables the token guard needs', async () => {
    // Read-only: these are populated by Django's own migrations.
    await expect(prisma.djangoContentType.count()).resolves.toBeGreaterThanOrEqual(0);
    await expect(prisma.authPermission.count()).resolves.toBeGreaterThanOrEqual(0);
    await expect(prisma.authGroup.count()).resolves.toBeGreaterThanOrEqual(0);
    await expect(prisma.authUserGroup.count()).resolves.toBeGreaterThanOrEqual(0);
    await expect(prisma.authUserUserPermission.count()).resolves.toBeGreaterThanOrEqual(0);
    await expect(prisma.authGroupPermission.count()).resolves.toBeGreaterThanOrEqual(0);
    await expect(prisma.djangoSession.count()).resolves.toBeGreaterThanOrEqual(0);
    await expect(prisma.djangoMigration.count()).resolves.toBeGreaterThanOrEqual(0);
  });

  it('covers every table in the database with a Prisma model', async () => {
    const tables = await prisma.$queryRaw<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
      ORDER BY tablename
    `;
    expect(tables.map((row) => row.tablename)).toEqual([
      'auth_group',
      'auth_group_permissions',
      'auth_permission',
      'auth_user',
      'auth_user_groups',
      'auth_user_user_permissions',
      'authtoken_token',
      'django_content_type',
      'django_migrations',
      'django_session',
      'fondo_api_activity',
      'fondo_api_activityuser',
      'fondo_api_activityyear',
      'fondo_api_file',
      'fondo_api_loan',
      'fondo_api_loandetail',
      'fondo_api_notificationsubscriptions',
      'fondo_api_power',
      'fondo_api_savingaccount',
      'fondo_api_schedulertask',
      'fondo_api_userfinance',
      'fondo_api_userpreference',
      'fondo_api_userprofile',
    ]);
  });

  it('keeps every foreign key DEFERRABLE INITIALLY DEFERRED, as Django created them', async () => {
    const rows = await prisma.$queryRaw<{ total: bigint; deferred: bigint }[]>`
      SELECT count(*) AS total,
             count(*) FILTER (WHERE condeferrable AND condeferred) AS deferred
      FROM pg_constraint WHERE contype = 'f'
    `;
    expect(Number(rows[0]?.total)).toBe(21);
    expect(Number(rows[0]?.deferred)).toBe(21);
  });

  it('has the hstore extension installed', async () => {
    const rows = await prisma.$queryRaw<{ extname: string }[]>`
      SELECT extname FROM pg_extension WHERE extname = 'hstore'
    `;
    expect(rows).toHaveLength(1);
  });
});
