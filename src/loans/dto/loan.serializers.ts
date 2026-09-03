import { formatDateEs } from '../../common/i18n/spanish-format';
import { fromDateColumn } from '../../common/utils/date.util';
import { toBogotaDate } from '../../common/utils/timezone.util';
import { Prisma } from '../../prisma/prisma-client';

/**
 * `fondo_api/serializers.py` — `LoanSerializer` (`:73-95`) and `LoanDetailSerializer`
 * (`:97-110`), ported as plain functions in the same shape as
 * `src/users/dto/user.serializers.ts`.
 *
 * ## Two DRF properties that are part of the wire format
 *
 * 1. **Key order is `Meta.fields` order**, not column order. `ModelSerializer.get_fields`
 *    walks the declared tuple into an `OrderedDict` and `JSONRenderer` does not sort, so
 *    `LoanSerializer` emits `value` first and `disbursement_value` last. The object literals
 *    below are written in that order and must stay in it.
 * 2. **`SerializerMethodField`s are computed** — `user_full_name`, `created_at`,
 *    `disbursement_date`, `is_refinanced`, `payday_limit`, `from_date`.
 *
 * ## ⚠️ `created_at` and `disbursement_date` are formatted differently, on purpose
 *
 * ```python
 * def get_created_at(self, obj):                       # serializers.py:88-90
 *     created_at = timezone.localtime(obj.created_at)  # timestamptz -> America/Bogota
 *     return format_date(created_at, locale=settings.LANGUAGE_LOCALE)
 *
 * def get_disbursement_date(self, obj):                # serializers.py:92-93
 *     return format_date(obj.disbursement_date, ...)   # DateField — no conversion at all
 * ```
 *
 * Plan rule 5c: reading `created_at` with {@link fromDateColumn} would render the **next
 * day's** date for every instant between 19:00 and 23:59 Bogota (~21% of every day), which is
 * green in CI and wrong in production. `formatDateEs` only accepts a `PlainDate`, so the
 * conversion has to be named here — {@link toBogotaDate} for the `timestamptz`,
 * {@link fromDateColumn} for the two `@db.Date` columns.
 */

/** `Loan.LOAN_STATES`. */
export const LOAN_WAITING_APPROVAL = 0;
export const LOAN_APPROVED = 1;
export const LOAN_DENIED = 2;
export const LOAN_PAID_OUT = 3;

/** `Loan.FEE_TYPES`. */
export const FEE_MONTHLY = 0;
export const FEE_UNIQUE = 1;

/** `Loan.PAYMENT_TYPES`. */
export const PAYMENT_CASH = 0;
export const PAYMENT_BANK_ACCOUNT = 1;
export const PAYMENT_REFINANCED = 2;

/** A `fondo_api_loan` row joined to the two halves of its owner, as every read here loads it. */
export interface LoanRow {
  readonly id: number;
  readonly value: bigint;
  readonly timelimit: number;
  readonly disbursement_date: Date;
  readonly payment: number;
  readonly created_at: Date;
  readonly fee: number;
  readonly comments: string | null;
  readonly state: number;
  readonly rate: Prisma.Decimal;
  readonly user_id: number;
  readonly prev_loan_id: number | null;
  readonly refinanced_loan: bigint | null;
  readonly disbursement_value: bigint | null;
  readonly user: {
    readonly auth_user: {
      readonly first_name: string;
      readonly last_name: string;
      readonly email: string;
    };
  };
}

/** A `fondo_api_loandetail` row. */
export interface LoanDetailRow {
  readonly minimum_payment: bigint;
  readonly total_payment: bigint;
  readonly payday_limit: Date;
  readonly interests: bigint;
  readonly capital_balance: bigint;
  readonly from_date: Date;
}

export interface LoanDto {
  value: bigint;
  timelimit: number;
  disbursement_date: string;
  payment: number;
  created_at: string;
  fee: number;
  comments: string | null;
  state: number;
  user_full_name: string;
  id: number;
  rate: string;
  is_refinanced: boolean;
  refinanced_loan: bigint | null;
  user_id: number;
  disbursement_value: bigint | null;
}

/**
 * `LoanSerializer`.
 *
 * ```python
 * fields = ('value','timelimit','disbursement_date', 'payment',
 *     'created_at','fee','comments','state','user_full_name','id','rate',
 *     'is_refinanced', 'refinanced_loan', 'user_id', 'disbursement_value')
 * ```
 *
 * ⚠️ **`rate` is a string, not a number.** `Loan.rate` is `DecimalField(max_digits=5,
 * decimal_places=3)`, `ModelSerializer` builds a `serializers.DecimalField` from it, and
 * `COERCE_DECIMAL_TO_STRING` defaults to `True` (v1 does not override it — `api/settings/base.py:87-98`
 * sets only the permission, authentication and test-format keys). `DecimalField.to_representation`
 * then does `'{:f}'.format(self.quantize(value))`, quantised to **three** decimal places. So a
 * rate of `0.02` renders as the six characters `"0.020"`, and a rate of `0` as `"0.000"`.
 * v1's own tests read it back through `Decimal(response.data['loan']['rate'])`, which only
 * type-checks on a string.
 *
 * ⚠️ **`user_id` is a plain integer, not a nested object.** `user_id` is not a model *field*
 * name, so `ModelSerializer.build_field` falls through to `build_property_field` (Django 2.2
 * sets the FK's `attname` as a class attribute in `Field.contribute_to_class`) and emits a
 * `ReadOnlyField` over `instance.user_id`.
 *
 * ⚠️ **`is_refinanced` is `obj.prev_loan != None`** — true when *this* loan refinances an
 * earlier one, i.e. it reads `prev_loan_id`, **not** `refinanced_loan`. The two point in
 * opposite directions and swapping them inverts the flag on every row of the chain.
 */
export function serializeLoan(loan: LoanRow): LoanDto {
  return {
    value: loan.value,
    timelimit: loan.timelimit,
    // DateField -> `format_date(obj.disbursement_date, ...)`, no localtime call.
    disbursement_date: formatDateEs(fromDateColumn(loan.disbursement_date)),
    payment: loan.payment,
    // timestamptz -> `format_date(timezone.localtime(obj.created_at), ...)`.
    created_at: formatDateEs(toBogotaDate(loan.created_at)),
    fee: loan.fee,
    comments: loan.comments,
    state: loan.state,
    user_full_name: `${loan.user.auth_user.first_name} ${loan.user.auth_user.last_name}`,
    id: loan.id,
    rate: serializeRate(loan.rate),
    is_refinanced: loan.prev_loan_id !== null,
    refinanced_loan: loan.refinanced_loan,
    user_id: loan.user_id,
    disbursement_value: loan.disbursement_value,
  };
}

export interface LoanDetailDto {
  minimum_payment: bigint;
  total_payment: bigint;
  payday_limit: string;
  interests: bigint;
  capital_balance: bigint;
  from_date: string;
}

/**
 * `LoanDetailSerializer`.
 *
 * ```python
 * fields = ('minimum_payment', 'total_payment','payday_limit','interests',
 *     'capital_balance','from_date')
 * ```
 *
 * Both dates are `DateField`s (`models.py:69,71`), so both use {@link fromDateColumn} — there
 * is no instant to localise, and `format_date` is called on them directly (`serializers.py:107,110`).
 */
export function serializeLoanDetail(detail: LoanDetailRow): LoanDetailDto {
  return {
    minimum_payment: detail.minimum_payment,
    total_payment: detail.total_payment,
    payday_limit: formatDateEs(fromDateColumn(detail.payday_limit)),
    interests: detail.interests,
    capital_balance: detail.capital_balance,
    from_date: formatDateEs(fromDateColumn(detail.from_date)),
  };
}

/**
 * `rest_framework.fields.DecimalField.to_representation` for `max_digits=5,
 * decimal_places=3`:
 *
 * ```python
 * quantized = value.quantize(Decimal('.1') ** 3, rounding=None, context=<prec=5>)
 * return '{:f}'.format(quantized)
 * ```
 *
 * The column is `numeric(5,3)`, so PostgreSQL already returns exactly three decimal places
 * and the quantisation is a no-op — but it is applied anyway, because `rate` is also rendered
 * straight after a write in the same request and Prisma's `Decimal` carries whatever scale
 * the literal had.
 */
export function serializeRate(rate: Prisma.Decimal): string {
  return rate.toFixed(3);
}
