import {
  ROLE_DISPLAY,
  serializePower,
  serializeUserBirthdate,
  serializeUserFinance,
  serializeUserFullInfo,
  serializeUserPreference,
  serializeUserProfile,
  type PowerRow,
  type UserFinanceRow,
  type UserPreferenceRow,
  type UserProfileRow,
} from './user.serializers';

const user: UserProfileRow = {
  user_ptr_id: 7,
  identification: 1098765432n,
  role: 2,
  birthdate: new Date(Date.UTC(1994, 4, 13)),
  auth_user: {
    email: 'criss9413@hotmail.com',
    first_name: 'Cristhian Daniel',
    last_name: 'Montañez Nuñez',
  },
};

const finance: UserFinanceRow = {
  contributions: 2000n,
  balance_contributions: 2000n,
  total_quota: 1000n,
  available_quota: 500n,
  utilized_quota: 0n,
  last_modified: new Date(Date.UTC(2021, 8, 26)),
};

const preference: UserPreferenceRow = {
  notifications: false,
  primary_color: '#800000',
  secondary_color: '#c83737',
};

describe('user serializers (fondo_api/serializers.py)', () => {
  describe('UserProfileSerializer', () => {
    it('emits Meta.fields in Meta.fields order', () => {
      expect(Object.keys(serializeUserProfile(user))).toEqual([
        'full_name',
        'identification',
        'email',
        'role_display',
        'id',
        'first_name',
        'last_name',
        'role',
        'birthdate',
      ]);
    });

    it('computes full_name and role_display, and keeps identification a bigint', () => {
      const dto = serializeUserProfile(user);
      expect(dto.full_name).toBe('Cristhian Daniel Montañez Nuñez');
      expect(dto.role_display).toBe('TREASURER');
      expect(dto.id).toBe(7);
      // Rendered as a bare JSON *number* by the global replacer (plan rule 5b), never a string.
      expect(dto.identification).toBe(1098765432n);
    });

    it('renders a DateField as ISO, and null as null', () => {
      expect(serializeUserProfile(user).birthdate).toBe('1994-05-13');
      expect(serializeUserProfile({ ...user, birthdate: null }).birthdate).toBeNull();
    });

    it('reads a @db.Date at UTC, so the day never shifts west of Greenwich', () => {
      // A `@db.Date` comes back as UTC midnight; reading local components would give the 12th
      // anywhere west of UTC, including Bogotá.
      expect(serializeUserProfile(user).birthdate).toBe('1994-05-13');
    });

    it('falls back to str(value) for a role outside ROLES, as Django’s _get_FIELD_display does', () => {
      expect(serializeUserProfile({ ...user, role: 9 }).role_display).toBe('9');
    });

    it('knows all four roles', () => {
      expect(ROLE_DISPLAY).toEqual({ 0: 'ADMIN', 1: 'PRESIDENT', 2: 'TREASURER', 3: 'MEMBER' });
    });
  });

  describe('UserFinanceSerializer', () => {
    it('emits Meta.fields in order, with the Spanish last_modified', () => {
      const dto = serializeUserFinance(finance, 0n);
      expect(Object.keys(dto)).toEqual([
        'contributions',
        'balance_contributions',
        'total_quota',
        'available_quota',
        'last_modified',
        'utilized_quota',
        'total_savingaccounts',
      ]);
      // Babel 2.9.1, locale `es`, `medium` format — the reference string from v1's own
      // `test_mail_service.py`.
      expect(dto.last_modified).toBe('26 sept. 2021');
    });

    it('formats last_modified WITHOUT a localtime conversion — it is a DateField', () => {
      // `serializers.py:29-30` has no `timezone.localtime`, unlike `get_created_at` at `:88`.
      // Reading this column as an instant and converting would give the previous day.
      const endOfMonth = { ...finance, last_modified: new Date(Date.UTC(2021, 8, 30)) };
      expect(serializeUserFinance(endOfMonth, 0n).last_modified).toBe('30 sept. 2021');
    });

    it('reports 0 for a member with no saving accounts — Python’s sum([]) is 0', () => {
      expect(serializeUserFinance(finance, 0n).total_savingaccounts).toBe(0n);
    });
  });

  describe('UserPreferenceSerializer', () => {
    it('emits the three fields', () => {
      expect(serializeUserPreference(preference)).toEqual({
        notifications: false,
        primary_color: '#800000',
        secondary_color: '#c83737',
      });
    });
  });

  describe('UserFullInfoSerializer', () => {
    it('emits all three declared fields — its Meta.fields is inert', () => {
      // ⚠️ It extends `serializers.Serializer`, not `ModelSerializer`, so `Meta.fields =
      // ('user', 'finance')` is ignored and `preferences` IS part of the response.
      const dto = serializeUserFullInfo(user, finance, 42n, preference);
      expect(Object.keys(dto)).toEqual(['user', 'finance', 'preferences']);
      expect(dto.finance.total_savingaccounts).toBe(42n);
      expect(dto.preferences.primary_color).toBe('#800000');
    });
  });

  describe('UserBirthdateSerializer', () => {
    it('emits birthdate first, then full_name', () => {
      expect(serializeUserBirthdate(user)).toEqual({
        birthdate: '1994-05-13',
        full_name: 'Cristhian Daniel Montañez Nuñez',
      });
    });
  });

  describe('PowerSerializer', () => {
    const power: PowerRow = {
      id: 3,
      state: 1,
      meeting_date: new Date(Date.UTC(2020, 0, 1)),
      requestee: { auth_user: { first_name: 'Ana', last_name: 'Ruiz' } },
      requester: { auth_user: { first_name: 'Luis', last_name: 'Gómez' } },
    };

    it('renders meeting_date as ISO, NOT in Spanish', () => {
      // ⚠️ Only the four explicit `SerializerMethodField` dates are Spanish-formatted. The
      // power-approval *email* formats the same column the other way
      // (`services/user.py:203`), and both are correct.
      expect(serializePower(power)).toEqual({
        id: 3,
        state: 1,
        meeting_date: '2020-01-01',
        requestee: 'Ana Ruiz',
        requester: 'Luis Gómez',
      });
    });
  });
});
