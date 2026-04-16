import {
  Role,
  LoanState,
  LoanFee,
  LoanPayment,
  ActivityUserState,
  SchedulerTaskType,
  SchedulerRepeat,
  FileType,
  PowerState,
  SavingAccountState,
  EmailTemplate,
} from './enums';

describe('Enums', () => {
  it('Role matchesROLES choices', () => {
    expect(Role.ADMIN).toBe(0);
    expect(Role.PRESIDENT).toBe(1);
    expect(Role.TREASURER).toBe(2);
    expect(Role.MEMBER).toBe(3);
  });

  it('LoanState matchesLOAN_STATES choices', () => {
    expect(LoanState.WAITING_APPROVAL).toBe(0);
    expect(LoanState.APPROVED).toBe(1);
    expect(LoanState.DENIED).toBe(2);
    expect(LoanState.PAID_OUT).toBe(3);
  });

  it('LoanFee matchesFEE_TYPES choices', () => {
    expect(LoanFee.MONTHLY).toBe(0);
    expect(LoanFee.UNIQUE).toBe(1);
  });

  it('LoanPayment matchesPAYMENT_TYPES choices', () => {
    expect(LoanPayment.CASH).toBe(0);
    expect(LoanPayment.BANK_ACCOUNT).toBe(1);
    expect(LoanPayment.REFINANCED).toBe(2);
  });

  it('ActivityUserState matchesSTATE_TYPES choices', () => {
    expect(ActivityUserState.NOT_PAID).toBe(0);
    expect(ActivityUserState.PAID_OUT).toBe(1);
    expect(ActivityUserState.EXEMPTED).toBe(2);
  });

  it('SchedulerTaskType matchesTASK_TYPES choices', () => {
    expect(SchedulerTaskType.NOTIFICATIONS).toBe(0);
  });

  it('SchedulerRepeat matchesREPEAT_TYPES choices', () => {
    expect(SchedulerRepeat.NONE).toBe(0);
    expect(SchedulerRepeat.DAILY).toBe(1);
    expect(SchedulerRepeat.WEEKLY).toBe(2);
    expect(SchedulerRepeat.MONTHLY).toBe(3);
    expect(SchedulerRepeat.YEARLY).toBe(4);
  });

  it('FileType matchesFILE_TYPE choices', () => {
    expect(FileType.PROCEEDING).toBe(0);
    expect(FileType.PRESENTATIONS).toBe(1);
  });

  it('PowerState matchesPOWER_STATE choices', () => {
    expect(PowerState.PENDING).toBe(0);
    expect(PowerState.APPROVED).toBe(1);
    expect(PowerState.REJECTED).toBe(2);
  });

  it('SavingAccountState matchesACCOUNT_STATE choices', () => {
    expect(SavingAccountState.ACTIVE).toBe(0);
    expect(SavingAccountState.CLOSED).toBe(1);
  });

  it('EmailTemplate matchesEmailTemplate choices', () => {
    expect(EmailTemplate.USER_ACTIVATION).toBe(1);
    expect(EmailTemplate.CHANGE_STATE_LOAN_APPROVED).toBe(2);
    expect(EmailTemplate.CHANGE_STATE_LOAN_DENIED).toBe(3);
    expect(EmailTemplate.POWER_APPROVED).toBe(4);
    expect(EmailTemplate.TEST).toBe(5);
    expect(EmailTemplate.PASSWORD_RESET).toBe(6);
  });
});
