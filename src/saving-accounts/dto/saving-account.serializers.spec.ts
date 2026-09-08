import {
  SAVING_ACCOUNT_ACTIVE,
  SAVING_ACCOUNT_CLOSED,
  serializeSavingAccount,
  type SavingAccountRow,
} from './saving-account.serializers';

/**
 * `fondo_api/serializers.py:SavingAccountSerializer` (`:161-179`).
 *
 * ⚠️ **v1 ships no test for this module at all** — there is no `test_saving_account_views.py`
 * and no serializer test. Every cell here is new coverage, written from the v1 source and
 * from the operator answers (**Q19**–**Q24**) rather than ported from an existing assertion.
 *
 * The centre of gravity is the **two date types in one serializer** (plan rule 5c, condition
 * **C1**): `created_at` is a `timestamptz` that v1 pushes through `timezone.localtime()`
 * first, `end_date` is a bare `DateField` that v1 formats with **no conversion at all**.
 */
function row(overrides: Partial<SavingAccountRow> = {}): SavingAccountRow {
  return {
    id: 3,
    // 2023-03-14 08:47 America/Bogota.
    created_at: new Date('2023-03-14T13:47:00.182Z'),
    // Prisma hands a `@db.Date` back at UTC midnight.
    end_date: new Date('2024-02-28T00:00:00.000Z'),
    state: SAVING_ACCOUNT_ACTIVE,
    value: 900000n,
    user_id: 15,
    user: { auth_user: { first_name: 'Angi Paola', last_name: 'Sanchez Quilindo' } },
    ...overrides,
  };
}

describe('SavingAccountSerializer', () => {
  // ==========================================================================
  // Shape and key order
  // ==========================================================================
  describe('the wire shape', () => {
    /**
     * `Meta.fields = ('value','created_at','state','user_full_name','id','end_date',)`.
     * `ModelSerializer.get_fields` walks that tuple into an `OrderedDict` and `JSONRenderer`
     * does not sort, so the wire order is the declaration order — not column order and not
     * alphabetical.
     */
    it('emits exactly the six Meta.fields, in Meta.fields order', () => {
      expect(Object.keys(serializeSavingAccount(row()))).toEqual([
        'value',
        'created_at',
        'state',
        'user_full_name',
        'id',
        'end_date',
      ]);
    });

    it('emits no field v1 does not declare — no user_id, no ORM internals', () => {
      const dto = serializeSavingAccount(row()) as unknown as Record<string, unknown>;
      expect(dto).not.toHaveProperty('user_id');
      expect(dto).not.toHaveProperty('user');
    });

    it('renders a whole row', () => {
      expect(serializeSavingAccount(row())).toEqual({
        value: 900000n,
        created_at: '14 mar. 2023',
        state: 0,
        user_full_name: 'Angi Paola Sanchez Quilindo',
        id: 3,
        end_date: '28 feb. 2024',
      });
    });

    /**
     * `value` is a `BigIntegerField`, so it stays a `bigint` here and is rendered as a bare
     * JSON number by the `json replacer` (plan rule 5b) — never a string, and never through
     * a 53-bit double.
     */
    it('keeps value as a bigint, exactly, past 2^53', () => {
      const dto = serializeSavingAccount(row({ value: 9007199254740993n }));
      expect(dto.value).toBe(9007199254740993n);
      expect(typeof dto.value).toBe('bigint');
    });

    it('reports state 1 for a closed CAP', () => {
      expect(serializeSavingAccount(row({ state: SAVING_ACCOUNT_CLOSED })).state).toBe(1);
    });
  });

  // ==========================================================================
  // get_user_full_name
  // ==========================================================================
  describe('get_user_full_name', () => {
    /** `'{} {}'.format(obj.user.first_name, obj.user.last_name)` — one space, no trimming. */
    it('joins the auth_user halves with a single space', () => {
      expect(
        serializeSavingAccount(
          row({ user: { auth_user: { first_name: 'Ana', last_name: 'Gil' } } }),
        ).user_full_name,
      ).toBe('Ana Gil');
    });

    /** Python's `format` on empty strings yields a bare space; not trimmed, not collapsed. */
    it('renders a lone space when both name halves are empty', () => {
      expect(
        serializeSavingAccount(row({ user: { auth_user: { first_name: '', last_name: '' } } }))
          .user_full_name,
      ).toBe(' ');
    });
  });

  // ==========================================================================
  // ⚠️ The two date conversions — plan rule 5c / condition C1
  // ==========================================================================
  describe('the two date types (rule 5c)', () => {
    /**
     * `get_created_at` converts first: `timezone.localtime(obj.created_at)` then
     * `format_date`. `2024-03-01T02:30Z` is **29 February** at 21:30 in Bogota, so the right
     * answer is February and the host-zone answer is March.
     *
     * The harness host zone is pinned to UTC (`jest.config.ts`), so a `fromDateColumn` read
     * here fails rather than passing by coincidence on a −05:00 laptop.
     */
    it('converts created_at to America/Bogota before formatting it', () => {
      expect(
        serializeSavingAccount(row({ created_at: new Date('2024-03-01T02:30:00.000Z') }))
          .created_at,
      ).toBe('29 feb. 2024');
    });

    it('keeps created_at on the same day when Bogota and UTC agree', () => {
      expect(
        serializeSavingAccount(row({ created_at: new Date('2024-03-01T14:00:00.000Z') }))
          .created_at,
      ).toBe('1 mar. 2024');
    });

    /**
     * ⚠️ The mirror-image mistake, and the more damaging one. `end_date` is a `DateField`
     * that v1 formats with **no conversion**, and Prisma returns `@db.Date` at UTC midnight —
     * so a `toBogotaDate` read would move **every** row back one day, unconditionally, not
     * just the evening ones.
     */
    it('formats end_date with no timezone conversion at all', () => {
      expect(
        serializeSavingAccount(row({ end_date: new Date('2024-03-01T00:00:00.000Z') })).end_date,
      ).toBe('1 mar. 2024');
    });

    /**
     * The two fields on one row, chosen so that the *correct* answers differ from the answers
     * either single mistake would give. This is the cell C1's split exists for.
     */
    it('gets both right on the one row where each wrong reading is visible', () => {
      const dto = serializeSavingAccount(
        row({
          // 31 Dec 2025 19:30 Bogota — the UTC date is already 1 Jan 2026.
          created_at: new Date('2026-01-01T00:30:00.000Z'),
          // Stored calendar date 1 Jan 2026; a Bogota read would say 31 Dec 2025.
          end_date: new Date('2026-01-01T00:00:00.000Z'),
        }),
      );
      expect(dto.created_at).toBe('31 dic. 2025');
      expect(dto.end_date).toBe('1 ene. 2026');
      // Stated negatively too, so a failure names the swap rather than only the value.
      expect(dto.created_at).not.toBe(dto.end_date);
    });

    /** Babel 2.9.1's `es` medium skeleton is `d MMM y` — no leading zero, four-letter `sept.`. */
    it.each([
      ['2024-01-05T12:00:00.000Z', '5 ene. 2024'],
      ['2024-09-09T12:00:00.000Z', '9 sept. 2024'],
      ['2024-12-31T12:00:00.000Z', '31 dic. 2024'],
    ])('formats %s as %s in Spanish', (iso, expected) => {
      expect(serializeSavingAccount(row({ end_date: new Date(iso) })).end_date).toBe(expected);
    });
  });
});
