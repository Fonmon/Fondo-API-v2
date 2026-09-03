import { formatDateEs, formatMoneyEs } from '../common/i18n/spanish-format';
import { days360, type PlainDate } from '../common/utils/date.util';
import { Decimal, toDecimal, type DecimalInput } from '../common/utils/decimal';
import { addRelativeDelta } from '../common/utils/relativedelta.util';
import { roundHalfEvenToBigInt } from '../common/utils/rounding.util';
import { FEE_MONTHLY } from './dto/loan.serializers';

/**
 * `fondo_api/services/loan.py::__generate_table` and `__calculate_interests` — the money
 * maths, kept out of the service so it can be unit-tested without a database.
 *
 * Every value on this path is a `Decimal` under Python's **default context**
 * (`prec=28, rounding=ROUND_HALF_EVEN`); `src/common/utils/decimal.ts` configures decimal.js
 * to match. A `number` anywhere here is a bug: the amortisation table compounds a rounding
 * disagreement over up to 36 rows and the result is emailed to the borrower.
 *
 * ## Three roundings, three different rules — all in v1, all load-bearing
 *
 * | v1 expression | rule | helper |
 * |---|---|---|
 * | `int(round(payment_value, 0))` → `minimum_payment` | Decimal, default context = **half-even** | {@link roundHalfEvenToBigInt} |
 * | `int(round(total_payment, 0))` | same | same |
 * | `format_number(format_decimal(round(x, 2), format='#'), locale='es')` **inside** `localcontext(Context(rounding=ROUND_HALF_DOWN))` | Decimal, **half-down**, applied twice | `formatMoneyEs` |
 *
 * The `with decimal.localcontext(...)` block wraps **only** the table-row rendering
 * (`services/loan.py:257-269`). The `if i == 1:` capture of `minimum_payment` / `interests`
 * and the `total_payment` accumulation sit *above* it and therefore run under the default
 * half-even context. Moving either across that boundary changes real money.
 */

/** The `Loan` fields the amortisation maths reads. */
export interface AmortizableLoan {
  readonly value: bigint;
  readonly timelimit: number;
  readonly fee: number;
  readonly rate: DecimalInput;
  /** `loan.disbursement_date`, already read out of the `@db.Date` column. */
  readonly disbursement_date: PlainDate;
}

/** The second half of `__generate_table`'s return tuple. */
export interface AmortizationSummary {
  readonly payday_limit: PlainDate;
  readonly minimum_payment: bigint;
  readonly total_payment: bigint;
  readonly interests: bigint;
}

export interface AmortizationResult {
  /** The `<table>` HTML interpolated into `loans/approved_email` as `{{loan_table}}`. */
  readonly table: string;
  readonly summary: AmortizationSummary;
}

/**
 * `__calculate_interests(loan, initial_balance, payment_date, initial_date_display)`:
 *
 * ```python
 * diff_days = days360(initial_date_display, payment_date)
 * interests = ((initial_balance * loan.rate) / 30) * diff_days
 * ```
 *
 * ⚠️ Argument order in v1 is `(payment_date, initial_date_display)` but `days360` is called
 * `(initial_date_display, payment_date)` — from-date first. `days360` swaps a reversed pair
 * and returns a **positive** count either way (`services/utils/date.py:8-11`), so a projection
 * to a date *before* `from_date` accrues positive interest in v1. Ported, not corrected.
 *
 * The division by 30 is exact-context Decimal division at 28 significant digits, which is
 * where the cents of a long loan are decided; `Number` arithmetic disagrees in the third
 * decimal place.
 */
export function calculateInterests(
  rate: DecimalInput,
  initialBalance: DecimalInput,
  fromDate: PlainDate,
  toDate: PlainDate,
): Decimal {
  const diffDays = days360(fromDate, toDate);
  return toDecimal(initialBalance).times(toDecimal(rate)).dividedBy(30).times(diffDays);
}

/**
 * `__generate_table(loan)`.
 *
 * ```python
 * fee = 1
 * if loan.fee == 0:
 *     fee = loan.timelimit
 * initial_date = loan.disbursement_date
 * initial_date_display = initial_date
 * initial_balance = Decimal(loan.value)
 * constant_payment = Decimal(loan.value) / fee
 * for i in range(1, fee + 1):
 *     payment_date = initial_date + (relativedelta(months=+i) if loan.fee == 0
 *                                    else relativedelta(months=+loan.timelimit))
 *     ...
 * ```
 *
 * Four things that are easy to get subtly wrong:
 *
 *  1. **`fee` is a *type*, not a count.** `fee == 0` is `MONTHLY` and means `timelimit`
 *     instalments; anything else (`1`, `UNIQUE`) is a **single** instalment at
 *     `+timelimit` months. The variable named `fee` inside the function is the instalment
 *     *count*, which is the opposite of the column's meaning.
 *  2. **`payment_date` is anchored to `disbursement_date`, not accumulated.**
 *     `initial_date + relativedelta(months=+i)` each iteration — so a loan disbursed on the
 *     31st pays on the 28th in February and back on the 31st in March. Accumulating
 *     `payment_date + 1 month` would clamp permanently after the first short month
 *     (`relativedelta.util.ts`, property 3) and drift by up to three days for the rest of
 *     the table.
 *  3. **`initial_date_display` lags by one row**: row `i`'s "Fecha inicial" is row `i-1`'s
 *     payment date, and the interest for row `i` is accrued over exactly that span.
 *  4. **`timelimit = 0` with `fee = 0` divides by zero** — v1 raises `DivisionByZero` here
 *     and 500s (`Decimal(loan.value) / 0`), *after* the loan row was already written at
 *     create time. That is deviation **D4**, closed at create time in
 *     `LoanService.createLoan`; this function still throws rather than inventing a value,
 *     because a row that predates the fix must not be silently approved with a made-up
 *     schedule.
 *
 * @throws RangeError when the instalment count is not positive (D4's residual).
 */
export function generateAmortizationTable(loan: AmortizableLoan): AmortizationResult {
  const instalments = loan.fee === FEE_MONTHLY ? loan.timelimit : 1;
  if (!Number.isInteger(instalments) || instalments < 1) {
    // `Decimal(loan.value) / 0` -> decimal.DivisionByZero -> uncaught 500 in v1.
    throw new RangeError(
      `DivisionByZero: loan timelimit must be a positive integer, received ${String(loan.timelimit)}`,
    );
  }

  const initialDate = loan.disbursement_date;
  let initialDateDisplay = initialDate;
  let initialBalance = toDecimal(loan.value);
  const constantPayment = toDecimal(loan.value).dividedBy(instalments);

  let firstPaymentValue = 0n;
  let firstInterests = 0n;
  let paydayLimit: PlainDate | null = null;
  let totalPayment = new Decimal(0);

  let table = '<table style="width:100%" border="1">';
  table +=
    '<tr>' +
    '<th>Cuota</th>' +
    '<th>Saldo inicial</th>' +
    '<th>Fecha inicial</th>' +
    '<th>Intereses</th>' +
    '<th>Abono a capital</th>' +
    '<th>Fecha de pago</th>' +
    '<th>Valor pago</th>' +
    '<th>Saldo final</th>' +
    '</tr>';

  for (let i = 1; i <= instalments; i += 1) {
    const paymentDate = addRelativeDelta(initialDate, {
      months: loan.fee === FEE_MONTHLY ? i : loan.timelimit,
    });
    const interests = calculateInterests(
      loan.rate,
      initialBalance,
      initialDateDisplay,
      paymentDate,
    );
    const paymentValue = constantPayment.plus(interests);
    const finalBalance = initialBalance.minus(constantPayment);

    if (i === 1) {
      // Default context: half-even. NOT the half-down context the row rendering uses.
      firstPaymentValue = roundHalfEvenToBigInt(paymentValue);
      firstInterests = roundHalfEvenToBigInt(interests);
      paydayLimit = paymentDate;
    }
    totalPayment = totalPayment.plus(paymentValue);

    // `with decimal.localcontext(decimal.Context(rounding=decimal.ROUND_HALF_DOWN)):`
    table += '<tr>';
    table += `<td>${i}</td>`;
    table += `<td>$${formatMoneyEs(initialBalance)}</td>`;
    table += `<td>${formatDateEs(initialDateDisplay)}</td>`;
    table += `<td>$${formatMoneyEs(interests)}</td>`;
    table += `<td>$${formatMoneyEs(constantPayment)}</td>`;
    table += `<td>${formatDateEs(paymentDate)}</td>`;
    table += `<td>$${formatMoneyEs(paymentValue)}</td>`;
    table += `<td>$${formatMoneyEs(finalBalance)}</td>`;
    table += '</tr>';

    initialBalance = finalBalance;
    initialDateDisplay = paymentDate;
  }
  table += '</table>';

  if (paydayLimit === null) {
    // Unreachable: `instalments >= 1` is asserted above.
    throw new RangeError('amortisation produced no instalments');
  }

  return {
    table,
    summary: {
      payday_limit: paydayLimit,
      minimum_payment: firstPaymentValue,
      total_payment: roundHalfEvenToBigInt(totalPayment),
      interests: firstInterests,
    },
  };
}

/**
 * `__get_rate(timelimit)` — the monthly interest rate table, as **commit `a45c343`** left it
 * (`services/loan.py:320-326`):
 *
 * ```python
 * if 6 < timelimit and timelimit <= 12:  return 0.020
 * elif 12 < timelimit and timelimit <= 24: return 0.022
 * elif 24 < timelimit and timelimit <= 36: return 0.025
 * return 0.015
 * ```
 *
 * ⚠️ **The final `return` is a fall-through, not an "else ≤ 6" branch.** A `timelimit`
 * *above* 36 also lands on `0.015` — which is only unreachable because `create_loan` clamps
 * to 36 first (`services/loan.py:31-32`). Keeping the fall-through shape means the clamp and
 * the table cannot drift apart silently.
 *
 * ⚠️ The rate is frozen at **request** time (operator Q4), so a loan awaiting approval across
 * a rate change is approved at the old rate. Nothing re-derives it at approval.
 *
 * Returned as a string so it reaches Prisma's `Decimal(5,3)` column without passing through a
 * binary float — `0.020` has no exact double representation and `numeric` would store the
 * error.
 */
export function getRate(timelimit: number): string {
  if (timelimit > 6 && timelimit <= 12) {
    return '0.020';
  }
  if (timelimit > 12 && timelimit <= 24) {
    return '0.022';
  }
  if (timelimit > 24 && timelimit <= 36) {
    return '0.025';
  }
  return '0.015';
}

/** `create_loan`'s silent upper clamp: `if int(obj['timelimit']) > 36: obj['timelimit'] = 36`. */
export const MAX_TIMELIMIT = 36;
