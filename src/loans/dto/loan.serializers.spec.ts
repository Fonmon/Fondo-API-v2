import { Prisma } from '../../prisma/prisma-client';
import {
  serializeLoan,
  serializeLoanDetail,
  serializeRate,
  type LoanDetailRow,
  type LoanRow,
} from './loan.serializers';
import {
  V1_LOAN_DETAIL_SERIALIZER_FIXTURES,
  V1_LOAN_SERIALIZER_FIXTURES,
  type LoanDetailSerializerFixture,
  type LoanSerializerFixture,
} from './loan.serializers.fixture';

/**
 * `LoanSerializer` / `LoanDetailSerializer` parity, checked **differentially** against output
 * captured from the running v1 stack over live `fondodev` rows
 * ({@link V1_LOAN_SERIALIZER_FIXTURES}).
 *
 * Whole objects are compared, never single fields — false-green instance #6 was a round-1 SES
 * check that passed while comparing one field of a payload that differed in another.
 */
describe('loan serializers — fondo_api/serializers.py:73-110', () => {
  describe('serializeLoan — differential against 11 live rows', () => {
    it.each(V1_LOAN_SERIALIZER_FIXTURES.map((f) => [f.raw.id, f] as const))(
      'loan %i renders exactly as v1 does',
      (_id, fixture) => {
        expect(toJson(serializeLoan(fixtureToLoanRow(fixture)))).toEqual(fixture.data);
      },
    );

    it.each(V1_LOAN_SERIALIZER_FIXTURES.map((f) => [f.raw.id, f] as const))(
      'loan %i emits DRF Meta.fields key order',
      (_id, fixture) => {
        expect(Object.keys(serializeLoan(fixtureToLoanRow(fixture)))).toEqual(fixture.keys);
      },
    );

    /**
     * ⚠️ **The rule 5c cell.** Loan 1's `created_at` is `2018-01-01T00:00:00+00:00` and v1
     * renders `31 dic. 2017`, because `get_created_at` calls `timezone.localtime` first
     * (`serializers.py:88-90`) while `get_disbursement_date` does not (`:92-93`). Reading the
     * `timestamptz` as its UTC calendar date would print `1 ene. 2018`.
     *
     * The host zone is pinned to UTC by `jest.config.ts` / `test/global-setup.ts` (false-green
     * #17), so this cell fails on a wrong conversion instead of passing by coincidence on a
     * `-05:00` laptop.
     */
    it('rule 5c: created_at is localised to Bogota, disbursement_date is not', () => {
      const fixture = V1_LOAN_SERIALIZER_FIXTURES.find((f) => f.raw.id === 1);
      expect(fixture).toBeDefined();
      expect(fixture?.raw.created_at).toBe('2018-01-01T00:00:00+00:00');

      const dto = serializeLoan(fixtureToLoanRow(fixture as LoanSerializerFixture));
      expect(dto.created_at).toBe('31 dic. 2017');
      // Not the UTC calendar date, which is the whole point.
      expect(dto.created_at).not.toBe('1 ene. 2018');
      expect(dto.disbursement_date).toBe('20 feb. 2017');
    });

    it('positive control: a shifted created_at changes the rendered date', () => {
      const fixture = V1_LOAN_SERIALIZER_FIXTURES[0];
      const row = fixtureToLoanRow(fixture);
      const shifted = serializeLoan({
        ...row,
        created_at: new Date(row.created_at.getTime() + 5 * 3_600_000),
      });
      // Proves the assertion above can fail: +5h crosses back into 1 Jan Bogota.
      expect(shifted.created_at).toBe('1 ene. 2018');
    });

    it('is_refinanced reads prev_loan_id, not refinanced_loan — they point opposite ways', () => {
      const base = fixtureToLoanRow(V1_LOAN_SERIALIZER_FIXTURES[0]);
      expect(serializeLoan({ ...base, prev_loan_id: 7, refinanced_loan: null }).is_refinanced).toBe(
        true,
      );
      expect(
        serializeLoan({ ...base, prev_loan_id: null, refinanced_loan: 9n }).is_refinanced,
      ).toBe(false);
    });

    it('the live fixture set actually contains both linkage directions', () => {
      // A positive control on the *fixture*, not the code: an all-null set would make the
      // is_refinanced column untested while every cell still "agreed".
      expect(V1_LOAN_SERIALIZER_FIXTURES.some((f) => f.raw.prev_loan_id !== null)).toBe(true);
      expect(V1_LOAN_SERIALIZER_FIXTURES.some((f) => f.raw.refinanced_loan !== null)).toBe(true);
      expect(V1_LOAN_SERIALIZER_FIXTURES.some((f) => f.raw.disbursement_value === null)).toBe(true);
      expect(new Set(V1_LOAN_SERIALIZER_FIXTURES.map((f) => f.raw.state)).size).toBeGreaterThan(1);
    });
  });

  describe('serializeRate — DRF DecimalField.to_representation', () => {
    it('renders three decimal places as a string, never a number', () => {
      expect(serializeRate(new Prisma.Decimal('0.02'))).toBe('0.020');
      expect(serializeRate(new Prisma.Decimal('0'))).toBe('0.000');
      expect(serializeRate(new Prisma.Decimal('0.025'))).toBe('0.025');
      expect(typeof serializeRate(new Prisma.Decimal('0.015'))).toBe('string');
    });

    it('every live rate renders as v1 rendered it', () => {
      for (const fixture of V1_LOAN_SERIALIZER_FIXTURES) {
        expect(serializeRate(new Prisma.Decimal(fixture.raw.rate))).toBe(fixture.data.rate);
      }
    });
  });

  describe('serializeLoanDetail — differential against 4 live rows', () => {
    it.each(V1_LOAN_DETAIL_SERIALIZER_FIXTURES.map((f, i) => [i, f] as const))(
      'detail %i renders exactly as v1 does',
      (_i, fixture) => {
        expect(toJson(serializeLoanDetail(fixtureToDetailRow(fixture)))).toEqual(fixture.data);
      },
    );

    it.each(V1_LOAN_DETAIL_SERIALIZER_FIXTURES.map((f, i) => [i, f] as const))(
      'detail %i emits DRF Meta.fields key order',
      (_i, fixture) => {
        expect(Object.keys(serializeLoanDetail(fixtureToDetailRow(fixture)))).toEqual(fixture.keys);
      },
    );

    it('both dates are @db.Date columns and get no timezone conversion', () => {
      const dto = serializeLoanDetail({
        minimum_payment: 1n,
        total_payment: 2n,
        // UTC midnight is how Prisma hands back a `@db.Date`; the calendar day must survive.
        payday_limit: new Date(Date.UTC(2018, 0, 1)),
        interests: 3n,
        capital_balance: 4n,
        from_date: new Date(Date.UTC(2017, 11, 31)),
      });
      expect(dto.payday_limit).toBe('1 ene. 2018');
      expect(dto.from_date).toBe('31 dic. 2017');
    });
  });
});

function fixtureToLoanRow(fixture: LoanSerializerFixture): LoanRow {
  const raw = fixture.raw;
  return {
    id: raw.id,
    value: BigInt(raw.value),
    timelimit: raw.timelimit,
    // `@db.Date` — Prisma returns UTC midnight.
    disbursement_date: new Date(`${raw.disbursement_date}T00:00:00.000Z`),
    payment: raw.payment,
    // `timestamptz` — a genuine instant.
    created_at: new Date(raw.created_at),
    fee: raw.fee,
    comments: raw.comments,
    state: raw.state,
    rate: new Prisma.Decimal(raw.rate),
    user_id: raw.user_id,
    prev_loan_id: raw.prev_loan_id,
    refinanced_loan: raw.refinanced_loan === null ? null : BigInt(raw.refinanced_loan),
    disbursement_value: raw.disbursement_value === null ? null : BigInt(raw.disbursement_value),
    user: {
      auth_user: {
        first_name: raw.first_name,
        last_name: raw.last_name,
        email: 'unused@example.com',
      },
    },
  };
}

function fixtureToDetailRow(fixture: LoanDetailSerializerFixture): LoanDetailRow {
  const raw = fixture.raw;
  return {
    minimum_payment: BigInt(raw.minimum_payment),
    total_payment: BigInt(raw.total_payment),
    payday_limit: new Date(`${raw.payday_limit}T00:00:00.000Z`),
    interests: BigInt(raw.interests),
    capital_balance: BigInt(raw.capital_balance),
    from_date: new Date(`${raw.from_date}T00:00:00.000Z`),
  };
}

/**
 * The DTOs carry `bigint`s, which the production `json replacer` renders as bare JSON numbers
 * (plan rule 5b). The fixture holds those as JSON numbers, so the comparison converts.
 * ⚠️ Deliberately **not** `JSON.parse(JSON.stringify(...))` — `JSON.stringify` throws on a
 * `bigint`, which is rule 5b's whole point.
 */
function toJson(dto: object): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(dto).map(([key, value]) => [
      key,
      typeof value === 'bigint' ? Number(value) : value,
    ]),
  );
}
