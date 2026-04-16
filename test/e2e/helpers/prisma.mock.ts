/**
 * Stateful in-memory mock for PrismaService.
 * Simulates DB operations without a real PostgreSQL connection.
 * Pre-seeded with fixture data matching the test setup.
 */

const ADMIN_ID = 1;
const PRESIDENT_ID = 2;
const ADMIN_TOKEN = '87b7f45a0624abb17df90ad71ba2767b31e0f8e6';
const PRESIDENT_TOKEN = '4a7197f0d2e2fd656f6ca1f89e32f0c075da00a1';

const MOCK_AUTH_USERS: Record<number, any> = {
  [ADMIN_ID]: {
    id: ADMIN_ID,
    username: 'angelitogomeza@hotmail.com',
    email: 'angelitogomeza@hotmail.com',
    first_name: 'Miguel Ángel',
    last_name: 'Montañez Gómez',
    is_active: true,
    password: 'pbkdf2_sha256$100000$testsalt$testhash',
    password_reset_token: null,
  },
  [PRESIDENT_ID]: {
    id: PRESIDENT_ID,
    username: 'cmiguelmg@gmail.com',
    email: 'cmiguelmg@gmail.com',
    first_name: 'Prueba',
    last_name: 'Prueba',
    is_active: true,
    password: 'pbkdf2_sha256$100000$testsalt$testhash',
    password_reset_token: null,
  },
};

const MOCK_PROFILES: Record<number, any> = {
  [ADMIN_ID]: {
    user_ptr_id: ADMIN_ID,
    role: 0,
    identification: BigInt(1234),
    birthdate: new Date('1990-03-15'),
    key: null,
  },
  [PRESIDENT_ID]: {
    user_ptr_id: PRESIDENT_ID,
    role: 1,
    identification: BigInt(234),
    birthdate: new Date('1992-07-20'),
    key: null,
  },
};

const MOCK_FINANCES: Record<number, any> = {
  [ADMIN_ID]: {
    id: 1,
    user_id: ADMIN_ID,
    contributions: BigInt(0),
    balance_contributions: BigInt(0),
    total_quota: BigInt(1000),
    available_quota: BigInt(1000),
    utilized_quota: BigInt(0),
    last_modified: new Date('2021-01-01'),
  },
  [PRESIDENT_ID]: {
    id: 2,
    user_id: PRESIDENT_ID,
    contributions: BigInt(0),
    balance_contributions: BigInt(0),
    total_quota: BigInt(500),
    available_quota: BigInt(500),
    utilized_quota: BigInt(0),
    last_modified: new Date('2021-01-01'),
  },
};

const MOCK_PREFERENCES: Record<number, any> = {
  [ADMIN_ID]: {
    id: 1,
    user_id: ADMIN_ID,
    notifications: true,
    primary_color: '#800000',
    secondary_color: '#c83737',
  },
  [PRESIDENT_ID]: {
    id: 2,
    user_id: PRESIDENT_ID,
    notifications: false,
    primary_color: '#000080',
    secondary_color: '#0000ff',
  },
};

function makeTokenRecord(token: string, userId: number): any {
  const user = MOCK_AUTH_USERS[userId];
  const profile = MOCK_PROFILES[userId];
  return {
    key: token,
    user_id: userId,
    created: new Date('2021-01-01'),
    auth_user: {
      ...user,
      fondo_api_userprofile: profile,
    },
  };
}

const TOKEN_MAP: Record<string, any> = {
  [ADMIN_TOKEN]: makeTokenRecord(ADMIN_TOKEN, ADMIN_ID),
  [PRESIDENT_TOKEN]: makeTokenRecord(PRESIDENT_TOKEN, PRESIDENT_ID),
};

export function createMockPrismaService(): any {
  // ─── In-memory stores ────────────────────────────────────────────────────────
  const loans = new Map<number, any>();
  const loanDetails = new Map<number, any>();
  const activities = new Map<number, any>();
  const activityUsers = new Map<number, any>();
  const activityYears = new Map<number, any>();
  const savingAccounts = new Map<number, any>();
  const files = new Map<number, any>();
  const powers = new Map<number, any>();

  // ─── Auto-increment counters ─────────────────────────────────────────────────
  let loanId = 0;
  let loanDetailId = 0;
  let activityId = 0;
  let activityUserId = 0;
  let yearId = 0;
  let accountId = 0;
  let fileId = 0;
  let powerId = 0;
  let newUserId = 100;

  // ─── Pre-seed fixture data ───────────────────────────────────────────────────
  // Fixture loans from DB dump
  loans.set(1, {
    id: 1, value: BigInt(1000000), timelimit: 24,
    disbursement_date: new Date('2015-01-01'), payment: 0,
    created_at: new Date('2015-01-01'), fee: 0, comments: null,
    state: 3, // PAID_OUT
    rate: 0.022, user_id: ADMIN_ID, prev_loan_id: null,
    refinanced_loan: null, disbursement_value: null,
  });
  loans.set(25, {
    id: 25, value: BigInt(500000), timelimit: 12,
    disbursement_date: new Date('2016-01-01'), payment: 0,
    created_at: new Date('2016-01-01'), fee: 0, comments: null,
    state: 2, // DENIED
    rate: 0.020, user_id: ADMIN_ID, prev_loan_id: null,
    refinanced_loan: null, disbursement_value: null,
  });
  loans.set(47, {
    id: 47, value: BigInt(200000), timelimit: 12,
    disbursement_date: new Date('2021-01-01'), payment: 0,
    created_at: new Date('2021-01-01'), fee: 0, comments: null,
    state: 0, // WAITING_APPROVAL
    rate: 0.020, user_id: ADMIN_ID, prev_loan_id: null,
    refinanced_loan: null, disbursement_value: null,
  });
  loanId = 50; // start new loans after fixture IDs

  // Fixture activity years
  activityYears.set(1, { id: 1, year: BigInt(2018), enable: false });
  activityYears.set(20, { id: 20, year: BigInt(2019), enable: false });
  yearId = 21;

  // Fixture activities
  activities.set(1, {
    id: 1, name: 'Almuerzo', date: new Date('2018-01-15'),
    value: BigInt(50000), year_id: 1,
  });
  activities.set(2, {
    id: 2, name: 'Activity 2', date: new Date('2018-03-15'),
    value: BigInt(30000), year_id: 1,
  });
  activityId = 3;

  // Fixture files
  files.set(1, {
    id: 1, display_name: 'Acta número 1', type: 0,
    created_at: new Date('2019-01-15'),
  });
  fileId = 2;

  // ─── Helper: attach user profile to any entity ───────────────────────────────
  function attachProfile(userId: number) {
    const profile = MOCK_PROFILES[userId];
    const user = MOCK_AUTH_USERS[userId];
    if (!profile || !user) return undefined;
    return { ...profile, auth_user: { ...user } };
  }

  function withProfile(entity: any, includeOpt?: any) {
    if (!includeOpt?.fondo_api_userprofile) return entity;
    return { ...entity, fondo_api_userprofile: attachProfile(entity.user_id) };
  }

  // ─── The mock object ─────────────────────────────────────────────────────────
  const mock: any = {

    // ─── Auth Token ─────────────────────────────────────────────────────────────
    authtoken_token: {
      findUnique: jest.fn().mockImplementation(async ({ where }: any) => {
        return TOKEN_MAP[where.key] ?? null;
      }),
      upsert: jest.fn().mockResolvedValue({}),
    },

    // ─── Auth User ──────────────────────────────────────────────────────────────
    auth_user: {
      findUnique: jest.fn().mockImplementation(async ({ where }: any) => {
        if (where.username) {
          return Object.values(MOCK_AUTH_USERS).find((u) => u.username === where.username) ?? null;
        }
        return MOCK_AUTH_USERS[where.id] ?? null;
      }),
      findFirst: jest.fn().mockImplementation(async ({ where }: any) => {
        if (where?.email) {
          return Object.values(MOCK_AUTH_USERS).find(
            (u) => u.email === where.email && (where.is_active === undefined || u.is_active === where.is_active),
          ) ?? null;
        }
        if (where?.password_reset_token) {
          return Object.values(MOCK_AUTH_USERS).find(
            (u) => u.password_reset_token === where.password_reset_token,
          ) ?? null;
        }
        return null;
      }),
      update: jest.fn().mockImplementation(async ({ where, data }: any) => {
        if (MOCK_AUTH_USERS[where.id]) {
          Object.assign(MOCK_AUTH_USERS[where.id], data);
        }
        return MOCK_AUTH_USERS[where.id] ?? {};
      }),
      create: jest.fn().mockImplementation(async ({ data }: any) => {
        const id = ++newUserId;
        MOCK_AUTH_USERS[id] = { id, ...data, is_active: false };
        return { ...MOCK_AUTH_USERS[id] };
      }),
    },

    // ─── User Profile ────────────────────────────────────────────────────────────
    fondo_api_userprofile: {
      findUnique: jest.fn().mockImplementation(async ({ where, include }: any) => {
        const profile = MOCK_PROFILES[where.user_ptr_id];
        if (!profile) return null;
        const user = MOCK_AUTH_USERS[profile.user_ptr_id];
        const result: any = { ...profile, auth_user: { ...user } };
        if (include?.fondo_api_userfinance) {
          result.fondo_api_userfinance = MOCK_FINANCES[profile.user_ptr_id]
            ? [{ ...MOCK_FINANCES[profile.user_ptr_id] }]
            : [];
        }
        if (include?.fondo_api_userpreference) {
          result.fondo_api_userpreference = MOCK_PREFERENCES[profile.user_ptr_id]
            ? [{ ...MOCK_PREFERENCES[profile.user_ptr_id] }]
            : [];
        }
        if (include?.fondo_api_savingaccount) {
          const userAccounts = [...savingAccounts.values()].filter(
            (a) => a.user_id === profile.user_ptr_id && a.state === 0,
          );
          result.fondo_api_savingaccount = userAccounts;
        }
        return result;
      }),
      findFirst: jest.fn().mockImplementation(async ({ where, include }: any) => {
        if (where?.identification !== undefined) {
          const found = Object.values(MOCK_PROFILES).find(
            (p) => BigInt(p.identification) === BigInt(where.identification),
          );
          return found ? { ...found, auth_user: { ...MOCK_AUTH_USERS[found.user_ptr_id] } } : null;
        }
        const id = where?.user_ptr_id ?? where?.user_id;
        const profile = MOCK_PROFILES[id];
        if (!profile) return null;
        const user = MOCK_AUTH_USERS[profile.user_ptr_id];
        return { ...profile, auth_user: { ...user } };
      }),
      findMany: jest.fn().mockImplementation(async ({ where }: any) => {
        let result = Object.values(MOCK_PROFILES);
        if (where?.role?.in) {
          result = result.filter((p) => where.role.in.includes(p.role));
        }
        if (where?.auth_user?.is_active !== undefined) {
          result = result.filter((p) => {
            const u = MOCK_AUTH_USERS[p.user_ptr_id];
            return u?.is_active === where.auth_user.is_active;
          });
        }
        return result.map((p) => ({
          ...p,
          auth_user: { ...MOCK_AUTH_USERS[p.user_ptr_id] },
        }));
      }),
      count: jest.fn().mockResolvedValue(Object.keys(MOCK_PROFILES).length),
      update: jest.fn().mockImplementation(async ({ where, data }: any) => {
        if (MOCK_PROFILES[where.user_ptr_id]) {
          Object.assign(MOCK_PROFILES[where.user_ptr_id], data);
        }
        return MOCK_PROFILES[where.user_ptr_id] ?? {};
      }),
      create: jest.fn().mockImplementation(async ({ data }: any) => {
        MOCK_PROFILES[data.user_ptr_id] = { ...data };
        return { ...MOCK_PROFILES[data.user_ptr_id] };
      }),
    },

    // ─── User Finance ────────────────────────────────────────────────────────────
    fondo_api_userfinance: {
      findFirst: jest.fn().mockImplementation(async ({ where }: any) => {
        return MOCK_FINANCES[where.user_id] ? { ...MOCK_FINANCES[where.user_id] } : null;
      }),
      update: jest.fn().mockImplementation(async ({ where, data }: any) => {
        if (MOCK_FINANCES[where.id]) {
          Object.assign(MOCK_FINANCES[where.id], data);
        }
        return MOCK_FINANCES[where.id] ?? {};
      }),
      create: jest.fn().mockImplementation(async ({ data }: any) => {
        const record = { id: Object.keys(MOCK_FINANCES).length + 1, ...data };
        MOCK_FINANCES[data.user_id] = record;
        return record;
      }),
    },

    // ─── User Preference ─────────────────────────────────────────────────────────
    fondo_api_userpreference: {
      findFirst: jest.fn().mockImplementation(async ({ where }: any) => {
        return MOCK_PREFERENCES[where.user_id] ? { ...MOCK_PREFERENCES[where.user_id] } : null;
      }),
      update: jest.fn().mockImplementation(async ({ where, data }: any) => {
        if (MOCK_PREFERENCES[where.id]) {
          Object.assign(MOCK_PREFERENCES[where.id], data);
        }
        return MOCK_PREFERENCES[where.id] ?? {};
      }),
      create: jest.fn().mockImplementation(async ({ data }: any) => {
        const record = { id: Object.keys(MOCK_PREFERENCES).length + 1, ...data };
        MOCK_PREFERENCES[data.user_id] = record;
        return record;
      }),
    },

    // ─── Loans ──────────────────────────────────────────────────────────────────
    fondo_api_loan: {
      create: jest.fn().mockImplementation(async ({ data, include }: any) => {
        const id = ++loanId;
        const loan: any = { id, ...data, fondo_api_loandetail: [] };
        loans.set(id, loan);
        return withProfile(loan, include);
      }),
      findUnique: jest.fn().mockImplementation(async ({ where, include }: any) => {
        const loan = loans.get(where.id);
        if (!loan) return null;
        const details = [...loanDetails.values()]
          .filter((d) => d.loan_id === where.id)
          .sort((a, b) => a.id - b.id);
        return {
          ...withProfile(loan, include),
          fondo_api_loandetail: details,
        };
      }),
      findMany: jest.fn().mockImplementation(async ({ where, include, skip, take }: any) => {
        let result = [...loans.values()];
        if (where?.user_id !== undefined) {
          result = result.filter((l) => l.user_id === where.user_id);
        }
        if (where?.state !== undefined) {
          result = result.filter((l) => l.state === where.state);
        }
        result.sort((a, b) => b.id - a.id);
        if (skip !== undefined) result = result.slice(skip);
        if (take !== undefined) result = result.slice(0, take);
        return result.map((l) => withProfile(l, include));
      }),
      count: jest.fn().mockImplementation(async ({ where }: any) => {
        let result = [...loans.values()];
        if (where?.user_id !== undefined) result = result.filter((l) => l.user_id === where.user_id);
        if (where?.state !== undefined) result = result.filter((l) => l.state === where.state);
        return result.length;
      }),
      update: jest.fn().mockImplementation(async ({ where, data, include }: any) => {
        const loan = loans.get(where.id);
        if (!loan) return null;
        const updated = { ...loan, ...data };
        loans.set(where.id, updated);
        return withProfile(updated, include);
      }),
    },

    // ─── Loan Details ────────────────────────────────────────────────────────────
    fondo_api_loandetail: {
      create: jest.fn().mockImplementation(async ({ data }: any) => {
        const id = ++loanDetailId;
        const detail: any = { id, ...data };
        loanDetails.set(id, detail);
        return detail;
      }),
      findMany: jest.fn().mockImplementation(async ({ where }: any) => {
        let result = [...loanDetails.values()];
        if (where?.loan_id !== undefined) {
          result = result.filter((d) => d.loan_id === where.loan_id);
        }
        return result.sort((a, b) => a.id - b.id);
      }),
      findFirst: jest.fn().mockImplementation(async ({ where }: any) => {
        const details = [...loanDetails.values()].filter((d) => d.loan_id === where.loan_id);
        return details.length > 0 ? details[0] : null;
      }),
      update: jest.fn().mockImplementation(async ({ where, data }: any) => {
        const detail = loanDetails.get(where.id);
        if (!detail) return null;
        const updated = { ...detail, ...data };
        loanDetails.set(where.id, updated);
        return updated;
      }),
    },

    // ─── Activity Years ──────────────────────────────────────────────────────────
    fondo_api_activityyear: {
      findUnique: jest.fn().mockImplementation(async ({ where }: any) => {
        if (where.year !== undefined) {
          for (const y of activityYears.values()) {
            if (BigInt(y.year) === BigInt(where.year)) return { ...y };
          }
          return null;
        }
        return activityYears.get(where.id) ? { ...activityYears.get(where.id) } : null;
      }),
      findMany: jest.fn().mockImplementation(async () => {
        return [...activityYears.values()].sort((a, b) => Number(b.year) - Number(a.year));
      }),
      create: jest.fn().mockImplementation(async ({ data }: any) => {
        const id = ++yearId;
        const year = { id, ...data };
        activityYears.set(id, year);
        return year;
      }),
      updateMany: jest.fn().mockImplementation(async ({ data }: any) => {
        for (const y of activityYears.values()) {
          Object.assign(y, data);
          activityYears.set(y.id, y);
        }
        return { count: activityYears.size };
      }),
    },

    // ─── Activities ──────────────────────────────────────────────────────────────
    fondo_api_activity: {
      create: jest.fn().mockImplementation(async ({ data }: any) => {
        const id = ++activityId;
        const activity = { id, ...data };
        activities.set(id, activity);
        return activity;
      }),
      findUnique: jest.fn().mockImplementation(async ({ where, include }: any) => {
        const activity = activities.get(where.id);
        if (!activity) return null;
        if (include?.fondo_api_activityuser) {
          const users = [...activityUsers.values()]
            .filter((au) => au.activity_id === where.id)
            .sort((a, b) => a.user_id - b.user_id)
            .map((au) => ({
              ...au,
              fondo_api_userprofile: {
                ...MOCK_PROFILES[au.user_id],
                auth_user: { ...MOCK_AUTH_USERS[au.user_id] },
              },
            }));
          return { ...activity, fondo_api_activityuser: users };
        }
        return { ...activity };
      }),
      findMany: jest.fn().mockImplementation(async ({ where }: any) => {
        let result = [...activities.values()];
        if (where?.year_id !== undefined) {
          result = result.filter((a) => a.year_id === where.year_id);
        }
        return result.sort((a, b) => b.date - a.date);
      }),
      update: jest.fn().mockImplementation(async ({ where, data }: any) => {
        const activity = activities.get(where.id);
        if (!activity) return null;
        const updated = { ...activity, ...data };
        activities.set(where.id, updated);
        return updated;
      }),
      delete: jest.fn().mockImplementation(async ({ where }: any) => {
        activities.delete(where.id);
        return {};
      }),
    },

    // ─── Activity Users ──────────────────────────────────────────────────────────
    fondo_api_activityuser: {
      create: jest.fn().mockImplementation(async ({ data }: any) => {
        const id = ++activityUserId;
        const au = { id, ...data };
        activityUsers.set(id, au);
        return au;
      }),
      deleteMany: jest.fn().mockImplementation(async ({ where }: any) => {
        let count = 0;
        for (const [key, au] of activityUsers.entries()) {
          if (where?.activity_id !== undefined && au.activity_id === where.activity_id) {
            activityUsers.delete(key);
            count++;
          }
          if (where?.user_id !== undefined && au.user_id === where.user_id) {
            activityUsers.delete(key);
            count++;
          }
        }
        return { count };
      }),
      update: jest.fn().mockImplementation(async ({ where, data }: any) => {
        const au = activityUsers.get(where.id);
        if (!au) return null;
        const updated = { ...au, ...data };
        activityUsers.set(where.id, updated);
        return updated;
      }),
    },

    // ─── Saving Accounts ─────────────────────────────────────────────────────────
    fondo_api_savingaccount: {
      create: jest.fn().mockImplementation(async ({ data }: any) => {
        const id = ++accountId;
        const account = { id, ...data };
        savingAccounts.set(id, account);
        return account;
      }),
      findMany: jest.fn().mockImplementation(async ({ where, skip, take }: any) => {
        let result = [...savingAccounts.values()];
        if (where?.user_id !== undefined) result = result.filter((a) => a.user_id === where.user_id);
        if (where?.state !== undefined) result = result.filter((a) => a.state === where.state);
        result.sort((a, b) => b.id - a.id);
        if (skip !== undefined) result = result.slice(skip);
        if (take !== undefined) result = result.slice(0, take);
        return result.map((a) => ({
          ...a,
          fondo_api_userprofile: {
            ...MOCK_PROFILES[a.user_id],
            auth_user: { ...MOCK_AUTH_USERS[a.user_id] },
          },
        }));
      }),
      count: jest.fn().mockImplementation(async ({ where }: any) => {
        let result = [...savingAccounts.values()];
        if (where?.user_id !== undefined) result = result.filter((a) => a.user_id === where.user_id);
        if (where?.state !== undefined) result = result.filter((a) => a.state === where.state);
        return result.length;
      }),
      update: jest.fn().mockImplementation(async ({ where, data }: any) => {
        const account = savingAccounts.get(where.id);
        if (!account) return null;
        const updated = { ...account, ...data };
        savingAccounts.set(where.id, updated);
        return {
          ...updated,
          fondo_api_userprofile: {
            ...MOCK_PROFILES[updated.user_id],
            auth_user: { ...MOCK_AUTH_USERS[updated.user_id] },
          },
        };
      }),
    },

    // ─── Files ───────────────────────────────────────────────────────────────────
    fondo_api_file: {
      findMany: jest.fn().mockImplementation(async ({ where }: any) => {
        let result = [...files.values()];
        if (where?.type !== undefined) result = result.filter((f) => f.type === where.type);
        return result.sort((a, b) => a.created_at - b.created_at);
      }),
      findUnique: jest.fn().mockImplementation(async ({ where }: any) => {
        return files.get(where.id) ? { ...files.get(where.id) } : null;
      }),
      create: jest.fn().mockImplementation(async ({ data }: any) => {
        const id = ++fileId;
        const file = { id, ...data };
        files.set(id, file);
        return file;
      }),
    },

    // ─── Notifications ───────────────────────────────────────────────────────────
    fondo_api_notificationsubscriptions: {
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },

    // ─── Powers ──────────────────────────────────────────────────────────────────
    fondo_api_power: {
      create: jest.fn().mockImplementation(async ({ data }: any) => {
        const id = ++powerId;
        const power = { id, ...data };
        powers.set(id, power);
        return power;
      }),
      findMany: jest.fn().mockImplementation(async ({ where, skip, take }: any) => {
        let result = [...powers.values()];
        if (where?.requested_id !== undefined) {
          result = result.filter((p) => p.requested_id === where.requested_id);
        }
        if (where?.requestee_id !== undefined) {
          result = result.filter((p) => p.requestee_id === where.requestee_id);
        }
        if (skip !== undefined) result = result.slice(skip);
        if (take !== undefined) result = result.slice(0, take);
        return result;
      }),
      count: jest.fn().mockImplementation(async ({ where }: any) => {
        let result = [...powers.values()];
        if (where?.requested_id !== undefined) result = result.filter((p) => p.requested_id === where.requested_id);
        if (where?.requestee_id !== undefined) result = result.filter((p) => p.requestee_id === where.requestee_id);
        return result.length;
      }),
      update: jest.fn().mockImplementation(async ({ where, data }: any) => {
        const power = powers.get(where.id);
        if (!power) return null;
        const updated = { ...power, ...data };
        powers.set(where.id, updated);
        return updated;
      }),
    },

    // ─── Raw SQL (for hstore notifications) ──────────────────────────────────────
    $queryRaw: jest.fn().mockResolvedValue([]),
    $executeRaw: jest.fn().mockResolvedValue(1),

    // ─── Transaction (passes mock to callback) ────────────────────────────────────
    $transaction: jest.fn().mockImplementation(async (fn: any) => fn(mock)),

    // ─── NestJS lifecycle ────────────────────────────────────────────────────────
    onModuleInit: jest.fn().mockResolvedValue(undefined),
  };

  return mock;
}
