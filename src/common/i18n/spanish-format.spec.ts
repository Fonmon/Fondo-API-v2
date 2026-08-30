import { formatDateEs, formatDecimalEs, formatMoneyEs } from './spanish-format';

const d = (year: number, month: number, day: number): Date =>
  new Date(Date.UTC(year, month - 1, day));

/**
 * Golden strings. Two sources, in priority order:
 *   1. strings asserted verbatim in v1's own tests (marked "v1:");
 *   2. output captured from CPython running v1's exact expression under `Babel==2.9.1`,
 *      for cases v1's tests never exercise.
 * Nothing here was derived from the JS implementation.
 */
describe('formatDateEs — babel.dates.format_date(value, locale="es")', () => {
  it('matches the month abbreviations asserted in v1 test_loan_views.py', () => {
    // v1: the amortisation table in test_approve_loan_fee_monthly
    expect(formatDateEs(d(2017, 11, 9))).toBe('9 nov. 2017');
    expect(formatDateEs(d(2017, 12, 9))).toBe('9 dic. 2017');
    expect(formatDateEs(d(2018, 1, 9))).toBe('9 ene. 2018');
    expect(formatDateEs(d(2018, 2, 9))).toBe('9 feb. 2018');
    expect(formatDateEs(d(2018, 3, 9))).toBe('9 mar. 2018');
    expect(formatDateEs(d(2018, 4, 9))).toBe('9 abr. 2018');
    expect(formatDateEs(d(2018, 5, 9))).toBe('9 may. 2018');
    expect(formatDateEs(d(2018, 6, 9))).toBe('9 jun. 2018');
    expect(formatDateEs(d(2018, 7, 9))).toBe('9 jul. 2018');
    expect(formatDateEs(d(2018, 8, 9))).toBe('9 ago. 2018');
    expect(formatDateEs(d(2018, 9, 9))).toBe('9 sept. 2018');
    expect(formatDateEs(d(2018, 12, 9))).toBe('9 dic. 2018');
  });

  it('matches the meeting date asserted in v1 test_mail_service.py', () => {
    // v1: mail_params['meeting_date'] = '26 sept. 2021'
    expect(formatDateEs(d(2021, 9, 26))).toBe('26 sept. 2021');
  });

  it('covers October, which v1 tests never render (Babel 2.9.1)', () => {
    expect(formatDateEs(d(2018, 10, 9))).toBe('9 oct. 2018');
  });

  it('does not zero-pad the day (pattern is "d MMM y", not "dd MMM y")', () => {
    expect(formatDateEs(d(2018, 1, 1))).toBe('1 ene. 2018');
    expect(formatDateEs(d(2018, 12, 31))).toBe('31 dic. 2018');
  });

  it('keeps the trailing period that Node Intl drops', () => {
    // Guards the exact reason this module exists instead of Intl.DateTimeFormat.
    for (const month of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
      expect(formatDateEs(d(2020, month, 15))).toMatch(/^15 [a-z]+\. 2020$/);
    }
  });

  it('accepts plain-date objects', () => {
    expect(formatDateEs({ year: 2021, month: 9, day: 26 })).toBe('26 sept. 2021');
  });
});

describe('formatMoneyEs — format_number(format_decimal(round(x, 2), format="#"), locale="es")', () => {
  it('matches the currency cells asserted in v1 test_loan_views.py', () => {
    // v1: '<td>$200</td>', '<td>$180</td>', '<td>$24</td>', '<td>$4</td>', '<td>$0</td>' ...
    expect(formatMoneyEs(200)).toBe('200');
    expect(formatMoneyEs(180)).toBe('180');
    expect(formatMoneyEs(24)).toBe('24');
    expect(formatMoneyEs(4)).toBe('4');
    expect(formatMoneyEs(0)).toBe('0');
    expect(formatMoneyEs(257)).toBe('257');
    expect(formatMoneyEs(57)).toBe('57');
  });

  it.each([
    ['0', '0'],
    ['1', '1'],
    ['999', '999'],
    ['1000', '1.000'],
    ['1234', '1.234'],
    ['9999', '9.999'],
    ['10000', '10.000'],
    ['12345', '12.345'],
    ['100000', '100.000'],
    ['123456', '123.456'],
    ['1000000', '1.000.000'],
    ['1234567', '1.234.567'],
    ['1234567890', '1.234.567.890'],
    ['-1000', '-1.000'],
    ['-1234', '-1.234'],
  ])('formatMoneyEs(%p) === %p (Babel 2.9.1)', (input, expected) => {
    expect(formatMoneyEs(input)).toBe(expected);
  });

  it('groups four-digit values — Babel 2.9.1 ignores CLDR minimumGroupingDigits', () => {
    // Node's Intl.NumberFormat('es') renders 1000 as "1000". Babel renders "1.000".
    expect(formatMoneyEs(1000)).toBe('1.000');
    expect(new Intl.NumberFormat('es').format(1000)).toBe('1000');
  });

  it.each([
    ['0.4', '0'],
    ['0.5', '0'],
    ['0.6', '1'],
    ['1.5', '1'],
    ['2.5', '2'],
    ['3.5', '3'],
    ['20.49', '20'],
    ['20.5', '20'],
    ['20.994', '21'],
    ['20.995', '21'],
    ['1000.5', '1.000'],
    ['1.005', '1'],
    ['2.675', '3'],
    ['2.4999', '2'],
  ])('rounds half-down: formatMoneyEs(%p) === %p', (input, expected) => {
    expect(formatMoneyEs(input)).toBe(expected);
  });

  it('applies TWO successive half-down roundings, exactly as v1 does', () => {
    // round('20.5001', 2) -> 20.50, then quantize to 0 half-down -> 20.
    // A single half-down rounding of 20.5001 would give 21. Babel 2.9.1 gives '20'.
    expect(formatMoneyEs('20.5001')).toBe('20');
    expect(formatMoneyEs('-20.5001')).toBe('-20');
  });

  it.each([
    ['-0.4', '-0'],
    ['-0.6', '-1'],
    ['-2.5', '-2'],
    ['99999.5', '99.999'],
    ['-100000.5', '-100.000'],
  ])('preserves Babel sign handling: formatMoneyEs(%p) === %p', (input, expected) => {
    expect(formatMoneyEs(input)).toBe(expected);
  });

  it('renders a negative value that rounds to zero as "-0", as Babel does', () => {
    // Babel takes abs() first and re-attaches the sign, so the string keeps the minus.
    expect(formatMoneyEs('-0.4')).toBe('-0');
  });
});

describe('formatDecimalEs — babel.numbers.format_decimal(value, locale="es")', () => {
  it.each([
    ['1000', '1.000'],
    ['10000', '10.000'],
    ['0.5', '0,5'],
    ['1234.5678', '1.234,568'],
    ['1234567.891', '1.234.567,891'],
    ['0', '0'],
    ['-1234.5', '-1.234,5'],
  ])('formatDecimalEs(%p) === %p (Babel 2.9.1)', (input, expected) => {
    expect(formatDecimalEs(input)).toBe(expected);
  });

  it('uses a comma for the decimal separator and a period for grouping', () => {
    expect(formatDecimalEs('1234.5')).toBe('1.234,5');
  });

  it('drops trailing zeros and caps at three fraction digits', () => {
    expect(formatDecimalEs('1.500')).toBe('1,5');
    expect(formatDecimalEs('1.0')).toBe('1');
    expect(formatDecimalEs('1.23456')).toBe('1,235');
  });
});
