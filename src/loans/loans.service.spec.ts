import { Test, TestingModule } from '@nestjs/testing';
import { LoansService } from './loans.service';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { NotificationsService } from '../notifications/notifications.service';
import { UsersService } from '../users/users.service';
import { LoanState, LoanFee } from '../common/enums';

describe('LoansService', () => {
  let service: LoansService;
  let prisma: any;
  let mail: jest.Mocked<MailService>;
  let notifications: jest.Mocked<NotificationsService>;
  let users: jest.Mocked<UsersService>;

  const mockLoan = {
    id: 1,
    value: BigInt(100000),
    timelimit: 12,
    disbursement_date: new Date('2026-03-20'),
    payment: 0,
    created_at: new Date('2026-03-20'),
    fee: 0,
    comments: null,
    state: LoanState.WAITING_APPROVAL,
    rate: { toString: () => '0.020' },
    user_id: 1,
    prev_loan_id: null,
    refinanced_loan: null,
    disbursement_value: null,
    fondo_api_userprofile: {
      user_ptr_id: 1,
      auth_user: { first_name: 'John', last_name: 'Doe', email: 'john@example.com' },
    },
  };

  const mockLoanDetail = {
    id: 1,
    total_payment: BigInt(9500),
    minimum_payment: BigInt(9000),
    payday_limit: new Date('2026-04-20'),
    interests: BigInt(500),
    capital_balance: BigInt(90000),
    from_date: new Date('2026-03-20'),
    loan_id: 1,
  };

  beforeEach(async () => {
    const mockPrisma = {
      fondo_api_loan: {
        create: jest.fn().mockResolvedValue(mockLoan),
        findMany: jest.fn().mockResolvedValue([mockLoan]),
        findUnique: jest.fn().mockResolvedValue(mockLoan),
        update: jest.fn().mockResolvedValue(mockLoan),
        count: jest.fn().mockResolvedValue(1),
      },
      fondo_api_loandetail: {
        findMany: jest.fn().mockResolvedValue([mockLoanDetail]),
        findFirst: jest.fn().mockResolvedValue(mockLoanDetail),
        create: jest.fn().mockResolvedValue(mockLoanDetail),
        update: jest.fn().mockResolvedValue(mockLoanDetail),
      },
      fondo_api_userfinance: {
        findFirst: jest.fn().mockResolvedValue({
          id: 1,
          available_quota: BigInt(500000),
        }),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LoansService,
        { provide: PrismaService, useValue: mockPrisma },
        {
          provide: MailService,
          useValue: {
            sendMail: jest.fn().mockResolvedValue(true),
          },
        },
        {
          provide: NotificationsService,
          useValue: {
            sendNotification: jest.fn().mockResolvedValue(undefined),
            scheduleNotification: jest.fn().mockResolvedValue(undefined),
            removeScheduledNotifications: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: UsersService,
          useValue: {
            getUsersAttr: jest.fn().mockResolvedValue([1, 2]),
          },
        },
      ],
    }).compile();

    service = module.get<LoansService>(LoansService);
    prisma = module.get(PrismaService);
    mail = module.get(MailService);
    notifications = module.get(NotificationsService);
    users = module.get(UsersService);
  });

  describe('createLoan', () => {
    it('should create a loan successfully', async () => {
      const body = {
        value: 100000,
        timelimit: 12,
        disbursement_date: '2026-03-20',
        payment: 0,
        fee: 0,
      };

      const result = await service.createLoan(1, body);
      expect(result).not.toBeNull();
      expect(prisma.fondo_api_loan.create).toHaveBeenCalled();
      expect(notifications.sendNotification).toHaveBeenCalled();
    });

    it('should return null when quota is insufficient', async () => {
      prisma.fondo_api_userfinance.findFirst.mockResolvedValue({
        id: 1,
        available_quota: BigInt(50000),
      });

      const body = { value: 100000, timelimit: 12, disbursement_date: '2026-03-20', payment: 0, fee: 0 };
      const result = await service.createLoan(1, body);
      expect(result).toBeNull();
    });

    it('should skip quota check for refinance', async () => {
      prisma.fondo_api_userfinance.findFirst.mockResolvedValue({ id: 1, available_quota: BigInt(50000) });
      const body = { value: 100000, timelimit: 12, disbursement_date: '2026-03-20', payment: 0, fee: 0 };
      const result = await service.createLoan(1, body, true, 5);
      expect(result).not.toBeNull();
    });

    it('should set rate based on timelimit (≤6)', async () => {
      const body = { value: 100000, timelimit: 6, disbursement_date: '2026-03-20', payment: 0, fee: 0 };
      await service.createLoan(1, body);
      expect(prisma.fondo_api_loan.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ rate: 0.015 }),
        }),
      );
    });

    it('should set rate based on timelimit (≤12)', async () => {
      const body = { value: 100000, timelimit: 12, disbursement_date: '2026-03-20', payment: 0, fee: 0 };
      await service.createLoan(1, body);
      expect(prisma.fondo_api_loan.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ rate: 0.020 }),
        }),
      );
    });

    it('should set rate based on timelimit (≤24)', async () => {
      const body = { value: 100000, timelimit: 24, disbursement_date: '2026-03-20', payment: 0, fee: 0 };
      await service.createLoan(1, body);
      expect(prisma.fondo_api_loan.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ rate: 0.022 }),
        }),
      );
    });

    it('should set rate based on timelimit (>24)', async () => {
      const body = { value: 100000, timelimit: 36, disbursement_date: '2026-03-20', payment: 0, fee: 0 };
      await service.createLoan(1, body);
      expect(prisma.fondo_api_loan.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ rate: 0.025 }),
        }),
      );
    });

    it('should include comments when provided', async () => {
      const body = { value: 100000, timelimit: 12, disbursement_date: '2026-03-20', payment: 0, fee: 0, comments: 'test' };
      await service.createLoan(1, body);
      expect(prisma.fondo_api_loan.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ comments: 'test' }),
        }),
      );
    });
  });

  describe('getLoans', () => {
    it('should return paginated loans', async () => {
      const result = await service.getLoans(1, 1, true, 4, true);
      expect(result).toHaveProperty('list');
      expect(result).toHaveProperty('num_pages');
    });

    it('should return unpaginated loans', async () => {
      const result = await service.getLoans(1, null, false, 0, false);
      expect(result).toHaveProperty('list');
      expect(result).not.toHaveProperty('num_pages');
    });

    it('should filter by user when allLoans=false', async () => {
      await service.getLoans(5, null, false, 4, false);
      expect(prisma.fondo_api_loan.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ user_id: 5 }),
        }),
      );
    });

    it('should filter by state when not 4', async () => {
      await service.getLoans(1, null, true, 1, false);
      expect(prisma.fondo_api_loan.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ state: 1 }),
        }),
      );
    });
  });

  describe('getLoan', () => {
    it('should return loan without loan_detail when state is not APPROVED', async () => {
      const loanWithDetails = { ...mockLoan, state: LoanState.WAITING_APPROVAL, fondo_api_loandetail: [mockLoanDetail] };
      prisma.fondo_api_loan.findUnique.mockResolvedValue(loanWithDetails);

      const result = await service.getLoan(1);
      expect(result).toHaveProperty('loan');
      expect(result).not.toHaveProperty('loan_detail');
    });

    it('should return loan_detail as single object when state is APPROVED', async () => {
      const approvedLoan = { ...mockLoan, state: LoanState.APPROVED, fondo_api_loandetail: [mockLoanDetail] };
      prisma.fondo_api_loan.findUnique.mockResolvedValue(approvedLoan);

      const result = await service.getLoan(1);
      expect(result).toHaveProperty('loan');
      expect(result).toHaveProperty('loan_detail');
      // loan_detail is a single object, not an array
      expect(Array.isArray((result as any).loan_detail)).toBe(false);
    });

    it('should return null when loan not found', async () => {
      prisma.fondo_api_loan.findUnique.mockResolvedValue(null);
      const result = await service.getLoan(999);
      expect(result).toBeNull();
    });
  });

  describe('updateLoan', () => {
    it('should return null when loan not found', async () => {
      prisma.fondo_api_loan.findUnique.mockResolvedValue(null);
      const result = await service.updateLoan(999, LoanState.APPROVED);
      expect(result).toBeNull();
    });

    it('should approve loan, create loan detail, and send email', async () => {
      const loanWithPrev = { ...mockLoan, prev_loan_id: 5 };
      prisma.fondo_api_loan.findUnique.mockResolvedValue(loanWithPrev);
      prisma.fondo_api_loan.update.mockResolvedValue({ ...loanWithPrev, state: LoanState.APPROVED });

      const result = await service.updateLoan(1, LoanState.APPROVED);
      expect(prisma.fondo_api_loandetail.create).toHaveBeenCalled();
      expect(mail.sendMail).toHaveBeenCalled();
    });

    it('should approve loan without prev_loan', async () => {
      prisma.fondo_api_loan.findUnique.mockResolvedValue(mockLoan);
      prisma.fondo_api_loan.update.mockResolvedValue({ ...mockLoan, state: LoanState.APPROVED });

      await service.updateLoan(1, LoanState.APPROVED);
      expect(prisma.fondo_api_loandetail.create).toHaveBeenCalled();
    });

    it('should deny loan and send denial email', async () => {
      const loanWithPrev = { ...mockLoan, prev_loan_id: 5 };
      prisma.fondo_api_loan.findUnique.mockResolvedValue(loanWithPrev);
      prisma.fondo_api_loan.update.mockResolvedValue({ ...loanWithPrev, state: LoanState.DENIED });

      await service.updateLoan(1, LoanState.DENIED);
      expect(mail.sendMail).toHaveBeenCalled();
    });

    it('should deny loan without prev_loan_id', async () => {
      prisma.fondo_api_loan.findUnique.mockResolvedValue(mockLoan);
      prisma.fondo_api_loan.update.mockResolvedValue({ ...mockLoan, state: LoanState.DENIED });

      await service.updateLoan(1, LoanState.DENIED);
      expect(mail.sendMail).toHaveBeenCalled();
    });

    it('should mark as PAID_OUT and remove notifications', async () => {
      prisma.fondo_api_loan.findUnique.mockResolvedValue(mockLoan);
      prisma.fondo_api_loan.update.mockResolvedValue({ ...mockLoan, state: LoanState.PAID_OUT });

      await service.updateLoan(1, LoanState.PAID_OUT);
      expect(notifications.removeScheduledNotifications).toHaveBeenCalled();
    });
  });

  describe('paymentProjection', () => {
    it('should calculate payment projection', async () => {
      const result = await service.paymentProjection(1, '2026-05-20');
      expect(result).toHaveProperty('interests');
      expect(result).toHaveProperty('capital_balance');
    });

    it('should return null when loan not found', async () => {
      prisma.fondo_api_loan.findUnique.mockResolvedValue(null);
      const result = await service.paymentProjection(999, '2026-05-20');
      expect(result).toBeNull();
    });

    it('should return null when no loan details', async () => {
      prisma.fondo_api_loandetail.findMany.mockResolvedValue([]);
      const result = await service.paymentProjection(1, '2026-05-20');
      expect(result).toBeNull();
    });
  });

  describe('refinanceLoan', () => {
    it('should refinance an approved loan', async () => {
      const approvedLoan = { ...mockLoan, state: LoanState.APPROVED };
      prisma.fondo_api_loan.findUnique.mockResolvedValue(approvedLoan);
      prisma.fondo_api_loan.create.mockResolvedValue({ ...mockLoan, id: 2 });

      const body = { value: 120000, timelimit: 18, disbursement_date: '2026-04-01', payment: 0, fee: 0 };
      const result = await service.refinanceLoan(1, body, 1);
      expect(result).not.toBeNull();
    });

    it('should return null when loan not found', async () => {
      prisma.fondo_api_loan.findUnique.mockResolvedValue(null);
      const body = { value: 120000, timelimit: 18, disbursement_date: '2026-04-01', payment: 0, fee: 0 };
      const result = await service.refinanceLoan(999, body, 1);
      expect(result).toBeNull();
    });

    it('should return null when loan is not approved', async () => {
      prisma.fondo_api_loan.findUnique.mockResolvedValue({ ...mockLoan, state: LoanState.WAITING_APPROVAL });
      const body = { value: 120000, timelimit: 18, disbursement_date: '2026-04-01', payment: 0, fee: 0 };
      const result = await service.refinanceLoan(1, body, 1);
      expect(result).toBeNull();
    });

    it('should return null when user does not own the loan', async () => {
      prisma.fondo_api_loan.findUnique.mockResolvedValue({ ...mockLoan, state: LoanState.APPROVED, user_id: 2 });
      const body = { value: 120000, timelimit: 18, disbursement_date: '2026-04-01', payment: 0, fee: 0 };
      const result = await service.refinanceLoan(1, body, 1);
      expect(result).toBeNull();
    });

    it('should return null when createLoan returns null', async () => {
      const approvedLoan = { ...mockLoan, state: LoanState.APPROVED };
      prisma.fondo_api_loan.findUnique.mockResolvedValue(approvedLoan);

      // Spy on createLoan to return null
      const spy = jest.spyOn(service, 'createLoan').mockResolvedValueOnce(null);

      const body = { value: 120000, timelimit: 18, disbursement_date: '2026-04-01', payment: 0, fee: 0 };
      const result = await service.refinanceLoan(1, body, 1);
      expect(result).toBeNull();

      spy.mockRestore();
    });
  });

  describe('bulkUpdateLoans', () => {
    it('should update existing loan details', async () => {
      prisma.fondo_api_loan.findUnique.mockResolvedValue(mockLoan);
      prisma.fondo_api_loan.findMany.mockResolvedValue([]);
      const tsv = '1\t9500\t9000\t20/04/2026\t500\t90000\t20/03/2026\n';
      await service.bulkUpdateLoans(Buffer.from(tsv));
      expect(prisma.fondo_api_loandetail.update).toHaveBeenCalled();
    });

    it('should create new loan detail when none exists', async () => {
      prisma.fondo_api_loandetail.findFirst.mockResolvedValue(null);
      prisma.fondo_api_loan.findUnique.mockResolvedValue(mockLoan);
      prisma.fondo_api_loan.findMany.mockResolvedValue([]);
      const tsv = '1\t9500\t9000\t20/04/2026\t500\t90000\t20/03/2026\n';
      await service.bulkUpdateLoans(Buffer.from(tsv));
      expect(prisma.fondo_api_loandetail.create).toHaveBeenCalled();
    });

    it('should auto-close approved loans not in the file', async () => {
      prisma.fondo_api_loandetail.findFirst.mockResolvedValue(null);
      prisma.fondo_api_loan.findUnique.mockResolvedValue(mockLoan);
      prisma.fondo_api_loan.findMany.mockResolvedValue([{ ...mockLoan, id: 99 }]);
      const tsv = '1\t9500\t9000\t20/04/2026\t500\t90000\t20/03/2026\n';
      await service.bulkUpdateLoans(Buffer.from(tsv));
      expect(prisma.fondo_api_loan.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 99 } }),
      );
    });

    it('should skip scheduled task when loan not found', async () => {
      prisma.fondo_api_loandetail.findFirst.mockResolvedValue(null);
      prisma.fondo_api_loan.findUnique.mockResolvedValue(null);
      prisma.fondo_api_loan.findMany.mockResolvedValue([]);
      const tsv = '999\t9500\t9000\t20/04/2026\t500\t90000\t20/03/2026\n';
      await service.bulkUpdateLoans(Buffer.from(tsv));
      expect(notifications.scheduleNotification).not.toHaveBeenCalled();
    });

    it('should NOT close approved loans that ARE in the processed file', async () => {
      prisma.fondo_api_loandetail.findFirst.mockResolvedValue(null);
      prisma.fondo_api_loan.findUnique.mockResolvedValue(mockLoan);
      // The same loan id=1 is in both the TSV and the approved list
      prisma.fondo_api_loan.findMany.mockResolvedValue([{ ...mockLoan, id: 1 }]);
      const tsv = '1\t9500\t9000\t20/04/2026\t500\t90000\t20/03/2026\n';
      await service.bulkUpdateLoans(Buffer.from(tsv));
      // Should NOT have called update with state PAID_OUT for loan 1 (it's in the file)
      const paidOutCalls = (prisma.fondo_api_loan.update as jest.Mock).mock.calls.filter(
        (call: any[]) => call[0]?.data?.state === 3
      );
      expect(paidOutCalls.length).toBe(0);
    });
  });

  describe('generateTable', () => {
    it('should generate table for MONTHLY fee', () => {
      const loan = {
        id: 1,
        value: BigInt(120000),
        timelimit: 3,
        disbursement_date: new Date('2026-03-20'),
        rate: { toString: () => '0.020' },
        fee: LoanFee.MONTHLY,
      };
      const { table, detail } = service.generateTable(loan);
      expect(table).toContain('<table');
      expect(detail).not.toBeNull();
    });

    it('should generate table for UNIQUE fee', () => {
      const loan = {
        id: 1,
        value: BigInt(100000),
        timelimit: 12,
        disbursement_date: new Date('2026-03-20'),
        rate: { toString: () => '0.020' },
        fee: LoanFee.UNIQUE,
      };
      const { table, detail } = service.generateTable(loan);
      expect(table).toContain('<table');
      expect(detail).not.toBeNull();
      // capital_balance is no longer in detail (stored separately as loan.value in DB)
      expect(detail!.total_payment).toBeGreaterThan(0);
    });
  });

  describe('createScheduledTask', () => {
    it('should create two scheduled notifications', async () => {
      await service.createScheduledTask(new Date('2026-04-20'), { id: 1, user_id: 1 });
      expect(notifications.scheduleNotification).toHaveBeenCalledTimes(2);
    });
  });

  describe('buildLoan response shape', () => {
    it('should return empty user_full_name when fondo_api_userprofile is absent', async () => {
      const loanNoProfile = { ...mockLoan, fondo_api_userprofile: undefined, fondo_api_loandetail: [] };
      prisma.fondo_api_loan.findUnique.mockResolvedValue(loanNoProfile);
      const result = await service.getLoan(1);
      expect(result!.loan.user_full_name).toBe('');
    });

    it('should include is_refinanced=true when prev_loan_id is set', async () => {
      const refinancedLoan = { ...mockLoan, prev_loan_id: 5, fondo_api_loandetail: [] };
      prisma.fondo_api_loan.findUnique.mockResolvedValue(refinancedLoan);
      const result = await service.getLoan(1);
      expect(result!.loan.is_refinanced).toBe(true);
    });

    it('should include refinanced_loan as number when set', async () => {
      const refinancedLoan = { ...mockLoan, refinanced_loan: BigInt(2), fondo_api_loandetail: [] };
      prisma.fondo_api_loan.findUnique.mockResolvedValue(refinancedLoan);
      const result = await service.getLoan(1);
      expect(result!.loan.refinanced_loan).toBe(2);
    });

    it('should include disbursement_value as number when set', async () => {
      const loanWithDisb = { ...mockLoan, disbursement_value: BigInt(95000), fondo_api_loandetail: [] };
      prisma.fondo_api_loan.findUnique.mockResolvedValue(loanWithDisb);
      const result = await service.getLoan(1);
      expect(result!.loan.disbursement_value).toBe(95000);
    });
  });
});
