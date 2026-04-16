import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { NotificationsService } from '../notifications/notifications.service';
import { UsersService } from '../users/users.service';
import {
  EmailTemplate,
  LoanState,
  LoanFee,
  SchedulerTaskType,
  SchedulerRepeat,
} from '../common/enums';
import { formatDateEs } from '../common/utils/date-format.util';
import { days360 } from '../common/utils/days360.util';
import { paginate, unpaginate } from '../common/pagination';

const ITEMS_PER_PAGE = 10;

function getLoanRate(timelimit: number): number {
  if (timelimit <= 6) return 0.015;
  if (timelimit <= 12) return 0.020;
  if (timelimit <= 24) return 0.022;
  return 0.025;
}

function formatCurrency(amount: number): string {
  return `$${new Intl.NumberFormat('es').format(Math.round(amount))}`;
}

function buildLoan(loan: {
  id: number;
  value: bigint;
  timelimit: number;
  disbursement_date: Date;
  payment: number;
  created_at: Date;
  fee: number;
  comments?: string | null;
  state: number;
  rate: any;
  user_id: number;
  prev_loan_id?: number | null;
  refinanced_loan?: bigint | null;
  disbursement_value?: bigint | null;
  fondo_api_userprofile?: {
    auth_user: { first_name: string; last_name: string };
  };
}) {
  return {
    value: Number(loan.value),
    timelimit: loan.timelimit,
    disbursement_date: formatDateEs(loan.disbursement_date),
    payment: loan.payment,
    created_at: formatDateEs(loan.created_at),
    fee: loan.fee,
    comments: loan.comments ?? null,
    state: loan.state,
    user_full_name: loan.fondo_api_userprofile
      ? `${loan.fondo_api_userprofile.auth_user.first_name} ${loan.fondo_api_userprofile.auth_user.last_name}`
      : '',
    id: loan.id,
    rate: parseFloat(String(loan.rate)).toFixed(3),
    is_refinanced: loan.prev_loan_id != null,
    refinanced_loan: loan.refinanced_loan !== null && loan.refinanced_loan !== undefined
      ? Number(loan.refinanced_loan)
      : null,
    user_id: loan.user_id,
    disbursement_value: loan.disbursement_value !== null && loan.disbursement_value !== undefined
      ? Number(loan.disbursement_value)
      : null,
  };
}

function buildLoanDetail(detail: {
  id: number;
  total_payment: bigint;
  minimum_payment: bigint;
  payday_limit: Date;
  interests: bigint;
  capital_balance: bigint;
  from_date: Date;
}) {
  return {
    minimum_payment: Number(detail.minimum_payment),
    total_payment: Number(detail.total_payment),
    payday_limit: formatDateEs(detail.payday_limit),
    interests: Number(detail.interests),
    capital_balance: Number(detail.capital_balance),
    from_date: formatDateEs(detail.from_date),
  };
}

@Injectable()
export class LoansService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly notifications: NotificationsService,
    private readonly users: UsersService,
  ) {}

  async createLoan(
    userId: number,
    body: {
      value: number;
      timelimit: number;
      disbursement_date: string;
      payment: number;
      fee: number;
      comments?: string;
    },
    refinance = false,
    prevLoanId?: number,
  ) {
    if (!refinance) {
      const finance = await this.prisma.fondo_api_userfinance.findFirst({
        where: { user_id: userId },
      });
      if (finance && Number(finance.available_quota) < body.value) {
        return null;
      }
    }

    const timelimit = Math.min(body.timelimit, 36);
    const rate = getLoanRate(timelimit);

    const loan = await this.prisma.fondo_api_loan.create({
      data: {
        value: BigInt(body.value),
        timelimit,
        disbursement_date: new Date(body.disbursement_date),
        payment: body.payment,
        fee: body.fee,
        comments: body.comments ?? null,
        state: LoanState.WAITING_APPROVAL,
        rate: rate,
        user_id: userId,
        prev_loan_id: prevLoanId ?? null,
        created_at: new Date(),
        disbursement_value: (body as any).disbursement_value != null ? BigInt((body as any).disbursement_value) : null,
      },
      include: {
        fondo_api_userprofile: { include: { auth_user: true } },
      },
    });

    const adminTreasurerIds = (await this.users.getUsersAttr('id', [0, 2])) as number[];
    await this.notifications.sendNotification(adminTreasurerIds, {
      body: `Nueva solicitud de préstamo #${loan.id}`,
      target: `/loan/${loan.id}`,
    });

    return buildLoan(loan);
  }

  async getLoans(
    userId: number,
    page: number | null,
    allLoans: boolean,
    state: number,
    shouldPaginate: boolean,
  ) {
    const where: Record<string, unknown> = {};
    if (!allLoans) where.user_id = userId;
    if (state !== 4) where.state = state;

    const [loans, total] = await Promise.all([
      this.prisma.fondo_api_loan.findMany({
        where,
        include: { fondo_api_userprofile: { include: { auth_user: true } } },
        orderBy: { id: 'desc' },
        ...(shouldPaginate && page !== null
          ? { skip: (page - 1) * ITEMS_PER_PAGE, take: ITEMS_PER_PAGE }
          : {}),
      }),
      this.prisma.fondo_api_loan.count({ where }),
    ]);

    const items = loans.map(buildLoan);

    if (shouldPaginate && page !== null) {
      return paginate(items, total, page, ITEMS_PER_PAGE);
    }
    return unpaginate(items);
  }

  async getLoan(id: number) {
    const loan = await this.prisma.fondo_api_loan.findUnique({
      where: { id },
      include: {
        fondo_api_userprofile: { include: { auth_user: true } },
        fondo_api_loandetail: {
          orderBy: { id: 'asc' },
        },
      },
    });
    if (!loan) return null;

    const builtLoan = buildLoan(loan);
    if (loan.state === LoanState.APPROVED && loan.fondo_api_loandetail.length > 0) {
      return { loan: builtLoan, loan_detail: buildLoanDetail(loan.fondo_api_loandetail[0]) };
    }
    return { loan: builtLoan };
  }

  async updateLoan(id: number, state: number) {
    const existingLoan = await this.prisma.fondo_api_loan.findUnique({
      where: { id },
      include: { fondo_api_userprofile: { include: { auth_user: true } } },
    });
    if (!existingLoan) return null;

    const loan = await this.prisma.fondo_api_loan.update({
      where: { id },
      data: { state },
      include: {
        fondo_api_userprofile: { include: { auth_user: true } },
      },
    });

    if (state === LoanState.APPROVED) {
      const { table, detail } = this.generateTable(loan);

      // Mark previous loan as paid out if exists
      if (loan.prev_loan_id) {
        await this.prisma.fondo_api_loan.update({
          where: { id: loan.prev_loan_id },
          data: { state: LoanState.PAID_OUT },
        });
      }

      // Create loan details — capital_balance = initial loan value (mirrors Django __create_loan_detail)
      if (detail) {
        const paydayDate = detail.payday_limit;
        await this.prisma.fondo_api_loandetail.create({
          data: {
            loan_id: id,
            total_payment: BigInt(detail.total_payment),
            minimum_payment: BigInt(detail.minimum_payment),
            payday_limit: paydayDate,
            interests: BigInt(detail.interests),
            capital_balance: loan.value, // initial loan value, not remaining balance
            from_date: loan.disbursement_date,
          },
        });
        await this.createScheduledTask(paydayDate, loan);
      }

      // Send approval email
      const userEmail = loan.fondo_api_userprofile.auth_user.email;
      const adminEmails = (await this.users.getUsersAttr('email', [0, 2])) as string[];
      await this.mail.sendMail(
        EmailTemplate.CHANGE_STATE_LOAN_APPROVED,
        [userEmail],
        { loan_id: id, loan_table: table },
        adminEmails,
      );

      // Return loan_detail + loan_table (loan_table allows E2E verification of days360 + date formatting)
      if (detail) {
        return {
          total_payment: detail.total_payment,
          minimum_payment: detail.minimum_payment,
          payday_limit: formatDateEs(detail.payday_limit),
          from_date: formatDateEs(loan.disbursement_date),
          interests: detail.interests,
          capital_balance: Number(loan.value),
          loan_table: table,
        };
      }
    } else if (state === LoanState.DENIED) {
      // Unlink prev loan
      if (loan.prev_loan_id) {
        await this.prisma.fondo_api_loan.update({
          where: { id: loan.prev_loan_id },
          data: { refinanced_loan: null },
        });
      }

      const userEmail = loan.fondo_api_userprofile.auth_user.email;
      const adminEmails = (await this.users.getUsersAttr('email', [0, 2])) as string[];
      await this.mail.sendMail(
        EmailTemplate.CHANGE_STATE_LOAN_DENIED,
        [userEmail],
        { loan_id: id },
        adminEmails,
      );
    } else if (state === LoanState.PAID_OUT) {
      await this.notifications.removeScheduledNotifications(
        loan.user_id,
        SchedulerTaskType.NOTIFICATIONS,
      );
    }

    return {};
  }

  async paymentProjection(loanId: number, toDate: string) {
    const details = await this.prisma.fondo_api_loandetail.findMany({
      where: { loan_id: loanId },
      orderBy: { id: 'asc' },
    });

    const loan = await this.prisma.fondo_api_loan.findUnique({
      where: { id: loanId },
    });
    if (!loan || details.length === 0) return null;

    const rate = parseFloat(String(loan.rate));
    const target = new Date(toDate + 'T00:00:00');

    // capital_balance = initial loan value; from_date = disbursement_date (mirrors Django)
    const detail = details[0];
    const balance = Number(detail.capital_balance);
    const fromDate = detail.from_date;

    const diffDays = days360(fromDate, target);
    const interests = Math.round((balance * rate / 30) * diffDays);

    return {
      interests,
      capital_balance: balance,
    };
  }

  async refinanceLoan(loanId: number, newLoanData: {
    disbursement_date: string;
    timelimit: number;
    fee: number;
    comments?: string;
    includeInterests?: boolean;
    payment?: number;
  }, userId: number) {
    const loan = await this.prisma.fondo_api_loan.findUnique({
      where: { id: loanId },
    });

    if (!loan || loan.state !== LoanState.APPROVED || loan.user_id !== userId) {
      return null;
    }

    // Get loan details to compute capital balance
    const details = await this.prisma.fondo_api_loandetail.findMany({
      where: { loan_id: loanId },
      orderBy: { id: 'asc' },
    });

    if (details.length === 0) return null;

    const capitalBalance = Number(details[0].capital_balance);
    let newValue = capitalBalance;

    if (newLoanData.includeInterests) {
      const rate = parseFloat(String(loan.rate));
      const target = new Date(newLoanData.disbursement_date + 'T00:00:00');
      const fromDate = details[0].from_date;
      const diffDays = days360(fromDate, target);
      const interests = Math.round((capitalBalance * rate / 30) * diffDays);
      newValue = capitalBalance + interests;
    }

    const baseComment = newLoanData.comments ? `. ${newLoanData.comments}` : '';
    const comment = `Refinanciación del crédito #${loanId}${baseComment}`;

    const newLoan = await this.createLoan(userId, {
      value: newValue,
      timelimit: newLoanData.timelimit,
      disbursement_date: newLoanData.disbursement_date,
      payment: 2, // REFINANCE
      fee: newLoanData.fee,
      comments: comment,
    }, true, loanId);
    if (!newLoan) return null;

    await this.prisma.fondo_api_loan.update({
      where: { id: loanId },
      data: { refinanced_loan: BigInt(newLoan.id) },
    });

    return newLoan;
  }

  async bulkUpdateLoans(fileBuffer: Buffer): Promise<void> {
    const content = fileBuffer.toString('utf-8');
    const lines = content.split('\n').filter((l) => l.trim());

    const processedLoanIds: number[] = [];

    for (const line of lines) {
      const parts = line.split('\t');
      const loanId = parseInt(parts[0].trim(), 10);
      const totalPayment = parseInt(parts[1].trim(), 10);
      const minimumPayment = parseInt(parts[2].trim(), 10);
      const paydayLimitStr = parts[3].trim(); // DD/MM/YYYY
      const interests = parseInt(parts[4].trim(), 10);
      const capitalBalance = parseInt(parts[5].trim(), 10);
      const fromDateStr = parts[6].trim(); // DD/MM/YYYY

      const [pd, pm, py] = paydayLimitStr.split('/');
      const paydayLimit = new Date(parseInt(py), parseInt(pm) - 1, parseInt(pd));
      const [fd, fm, fy] = fromDateStr.split('/');
      const fromDate = new Date(parseInt(fy), parseInt(fm) - 1, parseInt(fd));

      const existingDetail = await this.prisma.fondo_api_loandetail.findFirst({
        where: { loan_id: loanId },
      });

      if (existingDetail) {
        await this.prisma.fondo_api_loandetail.update({
          where: { id: existingDetail.id },
          data: {
            total_payment: BigInt(totalPayment),
            minimum_payment: BigInt(minimumPayment),
            payday_limit: paydayLimit,
            interests: BigInt(interests),
            capital_balance: BigInt(capitalBalance),
            from_date: fromDate,
          },
        });
      } else {
        await this.prisma.fondo_api_loandetail.create({
          data: {
            loan_id: loanId,
            total_payment: BigInt(totalPayment),
            minimum_payment: BigInt(minimumPayment),
            payday_limit: paydayLimit,
            interests: BigInt(interests),
            capital_balance: BigInt(capitalBalance),
            from_date: fromDate,
          },
        });
      }

      const loan = await this.prisma.fondo_api_loan.findUnique({ where: { id: loanId } });
      if (loan) {
        await this.createScheduledTask(paydayLimit, loan);
      }

      processedLoanIds.push(loanId);
    }

    // Auto-close approved loans not in the file
    const approvedLoans = await this.prisma.fondo_api_loan.findMany({
      where: { state: LoanState.APPROVED },
    });

    for (const loan of approvedLoans) {
      if (!processedLoanIds.includes(loan.id)) {
        await this.prisma.fondo_api_loan.update({
          where: { id: loan.id },
          data: { state: LoanState.PAID_OUT },
        });
      }
    }
  }

  /**
   * Mirrors Django's __generate_table:
   * - table columns: Cuota | Saldo inicial | Fecha inicial | Intereses | Abono a capital | Fecha de pago | Valor pago | Saldo final
   * - detail.total_payment = SUM of all payment values
   * - detail.minimum_payment = FIRST payment value
   * - detail.payday_limit = FIRST payment date
   * - detail.interests = FIRST period interests
   * fee=0 (MONTHLY): feeCount=timelimit installments, payment_date = disbursement + i months
   * fee=1 (UNIQUE): feeCount=1 installment, payment_date = disbursement + timelimit months
   */
  generateTable(loan: {
    id: number;
    value: bigint;
    timelimit: number;
    disbursement_date: Date;
    rate: any;
    fee: number;
  }): { table: string; detail: { payday_limit: Date; minimum_payment: number; total_payment: number; interests: number } | null } {
    const value = Number(loan.value);
    const rate = parseFloat(String(loan.rate));
    const feeType = loan.fee;
    const disbursementDate = loan.disbursement_date;

    // MONTHLY: feeCount = timelimit; UNIQUE: feeCount = 1
    const feeCount = feeType === LoanFee.MONTHLY ? loan.timelimit : 1;
    const constantCapital = value / feeCount; // Decimal capital per installment

    let table = '<table style="width:100%" border="1">';
    table += '<tr>'
      + '<th>Cuota</th>'
      + '<th>Saldo inicial</th>'
      + '<th>Fecha inicial</th>'
      + '<th>Intereses</th>'
      + '<th>Abono a capital</th>'
      + '<th>Fecha de pago</th>'
      + '<th>Valor pago</th>'
      + '<th>Saldo final</th>'
      + '</tr>';

    let balance = value;
    let currentDate = disbursementDate;
    let firstPaymentValue = 0;
    let firstInterests = 0;
    let paydayLimit: Date | null = null;
    let totalPaymentSum = 0;

    for (let i = 1; i <= feeCount; i++) {
      // MONTHLY: payment date = disbursement + i months
      // UNIQUE: payment date = disbursement + timelimit months
      const paymentDate = new Date(Date.UTC(
        disbursementDate.getUTCFullYear(),
        disbursementDate.getUTCMonth() + (feeType === LoanFee.MONTHLY ? i : loan.timelimit),
        disbursementDate.getUTCDate(),
      ));

      const diffDays = days360(currentDate, paymentDate);
      const interests = Math.round((balance * rate / 30) * diffDays);
      const capitalPayment = Math.round(constantCapital);
      const paymentValue = capitalPayment + interests;
      const finalBalance = balance - capitalPayment;

      if (i === 1) {
        firstPaymentValue = paymentValue;
        firstInterests = interests;
        paydayLimit = paymentDate;
      }
      totalPaymentSum += paymentValue;

      table += '<tr>';
      table += `<td>${i}</td>`;
      table += `<td>${formatCurrency(balance)}</td>`;
      table += `<td>${formatDateEs(currentDate)}</td>`;
      table += `<td>${formatCurrency(interests)}</td>`;
      table += `<td>${formatCurrency(capitalPayment)}</td>`;
      table += `<td>${formatDateEs(paymentDate)}</td>`;
      table += `<td>${formatCurrency(paymentValue)}</td>`;
      table += `<td>${formatCurrency(finalBalance)}</td>`;
      table += '</tr>';

      balance = finalBalance;
      currentDate = paymentDate;
    }

    table += '</table>';

    if (!paydayLimit) return { table, detail: null };

    return {
      table,
      detail: {
        payday_limit: paydayLimit,
        minimum_payment: firstPaymentValue,
        total_payment: Math.round(totalPaymentSum),
        interests: firstInterests,
      },
    };
  }

  async createScheduledTask(
    paydayLimit: Date,
    loan: { id: number; user_id: number },
  ): Promise<void> {
    const dateStr = formatDateEs(paydayLimit);

    // 5 days before
    const fiveBefore = new Date(paydayLimit);
    fiveBefore.setDate(fiveBefore.getDate() - 5);
    await this.notifications.scheduleNotification(
      loan.user_id,
      {
        body: `Recuerde que la fecha límite de pago para el crédito ${loan.id}, es el: ${dateStr}`,
        target: `/loan/${loan.id}`,
      },
      fiveBefore,
      SchedulerTaskType.NOTIFICATIONS,
      SchedulerRepeat.NONE,
    );

    // 1 day before
    const oneBefore = new Date(paydayLimit);
    oneBefore.setDate(oneBefore.getDate() - 1);
    await this.notifications.scheduleNotification(
      loan.user_id,
      {
        body: `Recuerde que la fecha límite de pago para el crédito ${loan.id}, es el: ${dateStr}`,
        target: `/loan/${loan.id}`,
      },
      oneBefore,
      SchedulerTaskType.NOTIFICATIONS,
      SchedulerRepeat.NONE,
    );
  }
}
