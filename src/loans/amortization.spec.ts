import { roundHalfEvenToBigInt } from '../common/utils/rounding.util';
import {
  calculateInterests,
  generateAmortizationTable,
  getRate,
  MAX_TIMELIMIT,
} from './amortization';
import { FEE_MONTHLY, FEE_UNIQUE } from './dto/loan.serializers';
import { V1_AMORTIZATION_FIXTURES, type AmortizationFixture } from './amortization.fixture';
import type { AmortizableLoan } from './amortization';
import type { PlainDate } from '../common/utils/date.util';

/**
 * Unit tests for the money maths of `fondo_api/services/loan.py`.
 *
 * ⚠️ **The two full-table expectations below are copied character for character out of
 * `fondo_api/tests/test_loan_views.py:420` and `:469`**, which assert them as the
 * `loan_table` argument of `MailService.send_mail`. They are v1's own output, not this
 * implementation's — that is the whole point, and re-deriving either of them from this code
 * would make the assertion circular (false-green class, register instance #3).
 */
describe('amortization — fondo_api/services/loan.py __generate_table / __calculate_interests', () => {
  // ==========================================================================
  // __get_rate — the table as commit a45c343 left it
  // ==========================================================================
  describe('getRate — the rate table (current, post-a45c343)', () => {
    it.each([
      [1, '0.015'],
      [5, '0.015'],
      [6, '0.015'],
      [7, '0.020'],
      [10, '0.020'],
      [12, '0.020'],
      [13, '0.022'],
      [20, '0.022'],
      [24, '0.022'],
      [25, '0.025'],
      [30, '0.025'],
      [36, '0.025'],
    ])('timelimit %i -> %s', (timelimit, expected) => {
      expect(getRate(timelimit)).toBe(expected);
    });

    it('falls through to 0.015 above 36 — reachable only if the clamp is removed', () => {
      // `services/loan.py:320-326` has no `else`; the final `return 0.015` catches both
      // `<= 6` and `> 36`. `create_loan` clamps first, which is why the second half is dead.
      expect(getRate(37)).toBe('0.015');
      expect(getRate(1000)).toBe('0.015');
    });

    it('returns strings, never floats — 0.020 has no exact double representation', () => {
      expect(typeof getRate(10)).toBe('string');
      // The observable consequence: `Number(0.020).toString()` is '0.02', one digit short of
      // the `numeric(5,3)` column and of DRF's three-place rendering.
      expect(getRate(10)).not.toBe(String(0.02));
    });

    it('MAX_TIMELIMIT is 36, matching the clamp in create_loan', () => {
      expect(MAX_TIMELIMIT).toBe(36);
    });
  });

  // ==========================================================================
  // __calculate_interests
  // ==========================================================================
  describe('calculateInterests — ((balance * rate) / 30) * days360(from, to)', () => {
    it('accrues nothing over a zero-length span (test_payment_projection, cell 1)', () => {
      const interests = calculateInterests(
        '0.020',
        200n,
        { year: 2017, month: 11, day: 9 },
        { year: 2017, month: 11, day: 9 },
      );
      expect(interests.toString()).toBe('0');
    });

    /**
     * ⚠️ **Not `0.8`.** `Decimal(200) * Decimal('0.020') / 30` is the repeating decimal
     * `0.1333333333333333333333333333` at the default 28-digit precision, and multiplying it
     * back by 6 lands *below* the exact value. Measured on CPython 3.9, not derived from this
     * code:
     *
     * ```
     * >>> ((Decimal(200) * Decimal('0.020')) / 30) * 6
     * Decimal('0.7999999999999999999999999998')
     * >>> int(round(_, 0))
     * 1
     * ```
     *
     * This is precisely why `common/utils/decimal.ts` pins `precision: 28`. decimal.js
     * defaults to 20 and would produce a different tail, which survives `round(x, 0)` on this
     * value but not on every one.
     */
    it('accrues 0.7999…8 over six days (test_payment_projection, cell 2 -> rounds to 1)', () => {
      const interests = calculateInterests(
        '0.020',
        200n,
        { year: 2017, month: 11, day: 9 },
        { year: 2017, month: 11, day: 15 },
      );
      expect(interests.toString()).toBe('0.7999999999999999999999999998');
      expect(roundHalfEvenToBigInt(interests)).toBe(1n);
    });

    /** Same shape over a full 30/360 month: `3.999…9`, which rounds and renders as 4. */
    it('accrues 3.999…9 over a 30/360 month (cell 3 -> rounds to 4)', () => {
      const interests = calculateInterests(
        '0.020',
        200n,
        { year: 2017, month: 11, day: 9 },
        { year: 2017, month: 12, day: 9 },
      );
      expect(interests.toString()).toBe('3.999999999999999999999999999');
      expect(roundHalfEvenToBigInt(interests)).toBe(4n);
    });

    it('is positive for a reversed range — days360 swaps the pair (services/utils/date.py:8-11)', () => {
      const forwards = calculateInterests(
        '0.020',
        200n,
        { year: 2017, month: 11, day: 9 },
        { year: 2017, month: 12, day: 9 },
      );
      const backwards = calculateInterests(
        '0.020',
        200n,
        { year: 2017, month: 12, day: 9 },
        { year: 2017, month: 11, day: 9 },
      );
      // v1 does not return a negative accrual; a projection into the past charges interest.
      expect(backwards.toString()).toBe(forwards.toString());
    });

    it('divides at 28 significant digits, not in binary floating point', () => {
      // 4.4 / 30 is a repeating decimal; Python's default context keeps 28 digits.
      const interests = calculateInterests(
        '0.022',
        200n,
        { year: 2017, month: 11, day: 9 },
        { year: 2018, month: 12, day: 9 },
      );
      expect(interests.toString()).toBe('57.20000000000000000000000001');
    });
  });

  // ==========================================================================
  // __generate_table — the two tables v1's own suite pins
  // ==========================================================================
  describe('generateAmortizationTable', () => {
    /** `test_update_loan_approved_monthly` — value 200, 10 monthly instalments, rate 0.020. */
    const MONTHLY_TABLE =
      '<table style="width:100%" border="1">' +
      '<tr><th>Cuota</th><th>Saldo inicial</th><th>Fecha inicial</th><th>Intereses</th>' +
      '<th>Abono a capital</th><th>Fecha de pago</th><th>Valor pago</th><th>Saldo final</th></tr>' +
      '<tr><td>1</td><td>$200</td><td>9 nov. 2017</td><td>$4</td><td>$20</td><td>9 dic. 2017</td><td>$24</td><td>$180</td></tr>' +
      '<tr><td>2</td><td>$180</td><td>9 dic. 2017</td><td>$4</td><td>$20</td><td>9 ene. 2018</td><td>$24</td><td>$160</td></tr>' +
      '<tr><td>3</td><td>$160</td><td>9 ene. 2018</td><td>$3</td><td>$20</td><td>9 feb. 2018</td><td>$23</td><td>$140</td></tr>' +
      '<tr><td>4</td><td>$140</td><td>9 feb. 2018</td><td>$3</td><td>$20</td><td>9 mar. 2018</td><td>$23</td><td>$120</td></tr>' +
      '<tr><td>5</td><td>$120</td><td>9 mar. 2018</td><td>$2</td><td>$20</td><td>9 abr. 2018</td><td>$22</td><td>$100</td></tr>' +
      '<tr><td>6</td><td>$100</td><td>9 abr. 2018</td><td>$2</td><td>$20</td><td>9 may. 2018</td><td>$22</td><td>$80</td></tr>' +
      '<tr><td>7</td><td>$80</td><td>9 may. 2018</td><td>$2</td><td>$20</td><td>9 jun. 2018</td><td>$22</td><td>$60</td></tr>' +
      '<tr><td>8</td><td>$60</td><td>9 jun. 2018</td><td>$1</td><td>$20</td><td>9 jul. 2018</td><td>$21</td><td>$40</td></tr>' +
      '<tr><td>9</td><td>$40</td><td>9 jul. 2018</td><td>$1</td><td>$20</td><td>9 ago. 2018</td><td>$21</td><td>$20</td></tr>' +
      '<tr><td>10</td><td>$20</td><td>9 ago. 2018</td><td>$0</td><td>$20</td><td>9 sept. 2018</td><td>$20</td><td>$0</td></tr>' +
      '</table>';

    /** `test_update_loan_approved_unique` — value 200, one instalment at +13 months, 0.022. */
    const UNIQUE_TABLE =
      '<table style="width:100%" border="1">' +
      '<tr><th>Cuota</th><th>Saldo inicial</th><th>Fecha inicial</th><th>Intereses</th>' +
      '<th>Abono a capital</th><th>Fecha de pago</th><th>Valor pago</th><th>Saldo final</th></tr>' +
      '<tr><td>1</td><td>$200</td><td>9 nov. 2017</td><td>$57</td><td>$200</td><td>9 dic. 2018</td><td>$257</td><td>$0</td></tr>' +
      '</table>';

    it('test_update_loan_approved_monthly: the HTML is byte-identical to v1', () => {
      const { table } = generateAmortizationTable({
        value: 200n,
        timelimit: 10,
        fee: FEE_MONTHLY,
        rate: '0.020',
        disbursement_date: { year: 2017, month: 11, day: 9 },
      });
      expect(table).toBe(MONTHLY_TABLE);
    });

    it('test_update_loan_approved_monthly: the LoanDetail summary matches v1', () => {
      const { summary } = generateAmortizationTable({
        value: 200n,
        timelimit: 10,
        fee: FEE_MONTHLY,
        rate: '0.020',
        disbursement_date: { year: 2017, month: 11, day: 9 },
      });
      expect(summary.total_payment).toBe(222n);
      expect(summary.minimum_payment).toBe(24n);
      expect(summary.interests).toBe(4n);
      expect(summary.payday_limit).toEqual({ year: 2017, month: 12, day: 9 });
    });

    it('test_update_loan_approved_unique: the HTML is byte-identical to v1', () => {
      const { table } = generateAmortizationTable({
        value: 200n,
        timelimit: 13,
        fee: FEE_UNIQUE,
        rate: '0.022',
        disbursement_date: { year: 2017, month: 11, day: 9 },
      });
      expect(table).toBe(UNIQUE_TABLE);
    });

    it('test_update_loan_approved_unique: one instalment, at +timelimit months', () => {
      const { summary } = generateAmortizationTable({
        value: 200n,
        timelimit: 13,
        fee: FEE_UNIQUE,
        rate: '0.022',
        disbursement_date: { year: 2017, month: 11, day: 9 },
      });
      expect(summary.total_payment).toBe(257n);
      // For a UNIQUE loan the minimum payment *is* the total payment.
      expect(summary.minimum_payment).toBe(257n);
      expect(summary.interests).toBe(57n);
      expect(summary.payday_limit).toEqual({ year: 2018, month: 12, day: 9 });
    });

    it('fee is a TYPE, not a count: MONTHLY produces `timelimit` rows, anything else one', () => {
      const monthly = generateAmortizationTable({
        value: 1200n,
        timelimit: 6,
        fee: FEE_MONTHLY,
        rate: '0.015',
        disbursement_date: { year: 2018, month: 1, day: 15 },
      });
      const unique = generateAmortizationTable({
        value: 1200n,
        timelimit: 6,
        fee: FEE_UNIQUE,
        rate: '0.015',
        disbursement_date: { year: 2018, month: 1, day: 15 },
      });
      expect((monthly.table.match(/<tr>/g) ?? []).length).toBe(7); // header + 6
      expect((unique.table.match(/<tr>/g) ?? []).length).toBe(2); // header + 1
    });

    /**
     * ⚠️ The regression this pins: `payment_date` is `initial_date + relativedelta(months=+i)`,
     * **anchored to the disbursement date**, not `previous_payment_date + 1 month`. An
     * accumulating implementation clamps permanently the first time it crosses February
     * (`relativedelta.util.ts` property 3) and then pays on the 28th for the rest of the loan.
     */
    it('anchors every payment date to disbursement_date, so a month-end loan does not drift', () => {
      const { table } = generateAmortizationTable({
        value: 400n,
        timelimit: 4,
        fee: FEE_MONTHLY,
        rate: '0.015',
        disbursement_date: { year: 2018, month: 1, day: 31 },
      });
      // Jan 31 + 1m = Feb 28 (clamped), + 2m = Mar 31 — *not* Mar 28.
      expect(table).toContain('<td>28 feb. 2018</td>');
      expect(table).toContain('<td>31 mar. 2018</td>');
      expect(table).toContain('<td>30 abr. 2018</td>');
      expect(table).toContain('<td>31 may. 2018</td>');
    });

    it('crosses a year end without losing a month', () => {
      const { table } = generateAmortizationTable({
        value: 300n,
        timelimit: 3,
        fee: FEE_MONTHLY,
        rate: '0.015',
        disbursement_date: { year: 2017, month: 11, day: 30 },
      });
      expect(table).toContain('<td>30 dic. 2017</td>');
      expect(table).toContain('<td>30 ene. 2018</td>');
      expect(table).toContain('<td>28 feb. 2018</td>');
    });

    it('the last row closes the balance at exactly $0', () => {
      const { table } = generateAmortizationTable({
        value: 3000n,
        timelimit: 12,
        fee: FEE_MONTHLY,
        rate: '0.020',
        disbursement_date: { year: 2020, month: 6, day: 15 },
      });
      expect(table).toContain(
        '<td>12</td><td>$250</td><td>15 may. 2021</td><td>$5</td><td>$250</td>' +
          '<td>15 jun. 2021</td><td>$255</td><td>$0</td>',
      );
    });

    /**
     * ⚠️ **D4's residual.** v1 accepts `timelimit = 0` at create, writes the row, and then
     * dies here with `decimal.DivisionByZero` from `Decimal(loan.value) / 0` — a 500 at
     * *approval* time. `LoanService.createLoan` now refuses it at create; this throw stays so
     * a row that predates the fix is not silently approved with an invented schedule.
     */
    it('D4: a zero timelimit on a MONTHLY loan throws rather than inventing a schedule', () => {
      expect(() =>
        generateAmortizationTable({
          value: 200n,
          timelimit: 0,
          fee: FEE_MONTHLY,
          rate: '0.015',
          disbursement_date: { year: 2018, month: 1, day: 1 },
        }),
      ).toThrow(/DivisionByZero/);
    });

    it('D4: a UNIQUE loan with timelimit 0 does NOT divide by zero — v1 would approve it', () => {
      // `fee = 1` for a non-MONTHLY loan, so the division is safe and the single payment
      // falls on the disbursement date itself. Included so the D4 boundary is stated, not
      // assumed: the crash is specific to `fee == 0`.
      const { summary, table } = generateAmortizationTable({
        value: 200n,
        timelimit: 0,
        fee: FEE_UNIQUE,
        rate: '0.015',
        disbursement_date: { year: 2018, month: 1, day: 1 },
      });
      expect(summary.payday_limit).toEqual({ year: 2018, month: 1, day: 1 });
      expect(summary.interests).toBe(0n);
      expect(table).toContain('<td>1 ene. 2018</td>');
    });

    /**
     * ⚠️ **The differential check.** 16 loans re-run through v1's own `__generate_table` inside
     * the v1 container (`Django==2.2.27` / CPython 3.9 / `Babel==2.9.1` /
     * `python-dateutil==2.7.5`) and captured as {@link V1_AMORTIZATION_FIXTURES}. Every table is
     * compared **whole**, not field by field, so a single wrong cell anywhere in a 36-row
     * schedule fails — the countermeasure §7 asks for after false-green #6, which passed by
     * comparing one field of a payload that differed in another.
     *
     * The cases cover the edges §3 Phase 4 lists as risks: month-end and leap-day
     * disbursement, the year rollover, `days360`'s 30/31 rule, `UNIQUE` vs `MONTHLY`, a
     * 36-row table, and real fund-scale money.
     */
    describe('differential against v1 — 16 loans captured from the running container', () => {
      it.each(Object.keys(V1_AMORTIZATION_FIXTURES))('%s: the whole table matches v1', (name) => {
        const fixture = V1_AMORTIZATION_FIXTURES[name];
        const { table } = generateAmortizationTable(fixtureToLoan(fixture));
        expect(table).toBe(fixture.table);
      });

      it.each(Object.keys(V1_AMORTIZATION_FIXTURES))('%s: the summary matches v1', (name) => {
        const fixture = V1_AMORTIZATION_FIXTURES[name];
        const { summary } = generateAmortizationTable(fixtureToLoan(fixture));
        expect({
          payday_limit: isoOf(summary.payday_limit),
          minimum_payment: Number(summary.minimum_payment),
          total_payment: Number(summary.total_payment),
          interests: Number(summary.interests),
        }).toEqual(fixture.summary);
      });

      /**
       * Positive control (§7's standing requirement). A matrix that can only ever agree is
       * satisfied by any uniform failure — instance #4 printed "72/72, 0 mismatches" while
       * every cell was a 401. This proves the comparison can fail: perturbing the rate by one
       * band must break at least one table.
       */
      it('positive control: a wrong rate makes the comparison fail', () => {
        const fixture = V1_AMORTIZATION_FIXTURES['monthly-200-10'];
        const { table } = generateAmortizationTable({
          ...fixtureToLoan(fixture),
          rate: '0.025',
        });
        expect(table).not.toBe(fixture.table);
      });

      it('positive control: the fixture set is not empty and covers both fee types', () => {
        const fixtures = Object.values(V1_AMORTIZATION_FIXTURES);
        expect(fixtures.length).toBe(16);
        expect(fixtures.some((f) => f.input.fee === FEE_MONTHLY)).toBe(true);
        expect(fixtures.some((f) => f.input.fee === FEE_UNIQUE)).toBe(true);
        // A 36-row schedule is present, so the "compounds over 36 rows" risk is exercised.
        expect(fixtures.some((f) => f.input.timelimit === 36 && f.input.fee === FEE_MONTHLY)).toBe(
          true,
        );
      });
    });

    it('rounds the summary half-EVEN and the table cells half-DOWN — the two disagree', () => {
      // A balance chosen so one instalment lands on an exact .5: half-even keeps the summary
      // on the even side while the rendered cell rounds toward zero.
      const { summary } = generateAmortizationTable({
        value: 5n,
        timelimit: 2,
        fee: FEE_MONTHLY,
        rate: '0.015',
        disbursement_date: { year: 2018, month: 1, day: 1 },
      });
      // constant_payment = 2.5; interests row 1 = (5 * .015 / 30) * 30 = 0.075
      // payment_value = 2.575 -> half-even to 0dp = 3
      expect(summary.minimum_payment).toBe(3n);
      // interests 0.075 -> half-even to 0dp = 0
      expect(summary.interests).toBe(0n);
    });
  });
});

/** Turns a captured fixture back into the `AmortizableLoan` v1 was given. */
function fixtureToLoan(fixture: AmortizationFixture): AmortizableLoan {
  return {
    value: BigInt(fixture.input.value),
    timelimit: fixture.input.timelimit,
    fee: fixture.input.fee,
    rate: fixture.input.rate,
    disbursement_date: parseIso(fixture.input.disbursement_date),
  };
}

function parseIso(iso: string): PlainDate {
  const [year, month, day] = iso.split('-').map(Number);
  return { year, month, day };
}

/** `date.isoformat()` — the form the fixture stores `payday_limit` in. */
function isoOf(date: PlainDate): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.year}-${pad(date.month)}-${pad(date.day)}`;
}
