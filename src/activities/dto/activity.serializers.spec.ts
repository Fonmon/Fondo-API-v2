import { Role } from '../../auth/permissions/roles';
import {
  serializeActivityDetail,
  serializeActivityGeneral,
  serializeActivityUser,
  serializeActivityYear,
  type ActivityDetailRow,
  type ActivityUserRow,
} from './activity.serializers';
import type { UserProfileRow } from '../../users/dto/user.serializers';

/**
 * `fondo_api/serializers.py:113-138`, at the unit level.
 *
 * The three properties under test are the ones a reader would "tidy" away: `Meta.fields`
 * order, `BigInt` staying a `bigint` (plan rule **5b**), and `date` rendering **ISO**
 * rather than Spanish (plan rule 5c does *not* apply — see the module docblock).
 */
describe('activity serializers (unit)', () => {
  const member = (overrides: Partial<UserProfileRow> = {}): UserProfileRow => ({
    user_ptr_id: 7,
    identification: 99999n,
    role: Role.MEMBER,
    birthdate: new Date(Date.UTC(1990, 4, 3)),
    auth_user: {
      email: 'member@mail.com',
      first_name: 'Foo Name',
      last_name: 'Foo Last Name',
    },
    ...overrides,
  });

  describe('ActivityYearSerializer', () => {
    it('emits id, year and enable, in Meta.fields order', () => {
      const dto = serializeActivityYear({ id: 3, year: 2020n, enable: true });
      expect(dto).toEqual({ id: 3, year: 2020n, enable: true });
      expect(Object.keys(dto)).toEqual(['id', 'year', 'enable']);
    });

    /** Rule 5b: `year` is a `BigIntegerField`, so DRF renders a bare number, not a string. */
    it('leaves year as a bigint for the global json replacer', () => {
      expect(typeof serializeActivityYear({ id: 1, year: 2026n, enable: false }).year).toBe(
        'bigint',
      );
    });

    /**
     * ⚠️ `enable` is echoed, never recomputed. `fondo_api_activityyear` holds **two** enabled
     * rows in production (2026 and 2020) and nothing in v1 reads the flag — a serializer that
     * derived it from `year === currentYear` would diverge on real data while passing against
     * a tidy fixture. `docs/phase-5-prework.md` §1.
     */
    it('echoes a disabled year rather than deriving it from the current year', () => {
      expect(serializeActivityYear({ id: 3, year: 2020n, enable: true }).enable).toBe(true);
      expect(serializeActivityYear({ id: 9, year: 2025n, enable: false }).enable).toBe(false);
    });
  });

  describe('ActivityGeneralSerializer', () => {
    it('emits id and name only', () => {
      const dto = serializeActivityGeneral({ id: 1, name: 'Test Activity 1' });
      expect(dto).toEqual({ id: 1, name: 'Test Activity 1' });
      expect(Object.keys(dto)).toEqual(['id', 'name']);
    });
  });

  describe('ActivityUserSerializer', () => {
    const row: ActivityUserRow = { id: 42, state: 2, user: member() };

    it('emits id, state and the nested UserProfileSerializer, in that order', () => {
      const dto = serializeActivityUser(row);
      expect(Object.keys(dto)).toEqual(['id', 'state', 'user']);
      expect(dto.id).toBe(42);
      expect(dto.state).toBe(2);
      expect(dto.user).toEqual({
        full_name: 'Foo Name Foo Last Name',
        identification: 99999n,
        email: 'member@mail.com',
        role_display: 'MEMBER',
        id: 7,
        first_name: 'Foo Name',
        last_name: 'Foo Last Name',
        role: Role.MEMBER,
        birthdate: '1990-05-03',
      });
    });

    /**
     * ⚠️ `id` is the `ActivityUser` row's id, not the member's — it is what
     * `?patch=user` addresses (`services/activity.py:84-85`).
     */
    it('uses the ActivityUser id, not the member id', () => {
      expect(serializeActivityUser(row).id).not.toBe(row.user.user_ptr_id);
    });
  });

  describe('ActivityDetailSerializer', () => {
    const activity: ActivityDetailRow = {
      id: 11,
      name: 'New Activity for tests',
      date: new Date(Date.UTC(2020, 10, 7)),
      value: 30000n,
      users: [{ id: 42, state: 0, user: member() }],
    };

    it('emits id, name, date, value, users, in Meta.fields order', () => {
      expect(Object.keys(serializeActivityDetail(activity))).toEqual([
        'id',
        'name',
        'date',
        'value',
        'users',
      ]);
    });

    /**
     * ⚠️ **ISO, not Spanish.** `test_activity_views.py:148` asserts `'2020-11-07'`. Only the
     * `SerializerMethodField`s that call `babel.dates.format_date` are Spanish
     * (`last_modified`, `created_at`, `payday_limit`, `from_date`); this is a plain
     * `ModelSerializer` field. A `formatDateEs` here would render `7 nov. 2020`.
     */
    it('renders date as ISO YYYY-MM-DD, not the Spanish babel format', () => {
      const dto = serializeActivityDetail(activity);
      expect(dto.date).toBe('2020-11-07');
      expect(dto.date).not.toMatch(/nov/);
    });

    /** Rule 5b again — `value` is a `BigIntegerField`. */
    it('leaves value as a bigint', () => {
      expect(serializeActivityDetail(activity).value).toBe(30000n);
    });

    it('renders an empty users list as [] (v1 test_update_activity)', () => {
      expect(serializeActivityDetail({ ...activity, users: [] }).users).toEqual([]);
    });

    /** The order is decided by the query (`order_by('user_id')`) and preserved verbatim. */
    it('preserves the order the query returned', () => {
      const dto = serializeActivityDetail({
        ...activity,
        users: [
          { id: 90, state: 1, user: member({ user_ptr_id: 2 }) },
          { id: 12, state: 0, user: member({ user_ptr_id: 5 }) },
        ],
      });
      expect(dto.users.map((u) => u.id)).toEqual([90, 12]);
    });
  });
});
