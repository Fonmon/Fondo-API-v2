export enum Role {
  ADMIN = 0,
  PRESIDENT = 1,
  TREASURER = 2,
  MEMBER = 3,
}

export enum LoanState {
  WAITING_APPROVAL = 0,
  APPROVED = 1,
  DENIED = 2,
  PAID_OUT = 3,
}

export enum LoanFee {
  MONTHLY = 0,
  UNIQUE = 1,
}

export enum LoanPayment {
  CASH = 0,
  BANK_ACCOUNT = 1,
  REFINANCED = 2,
}

export enum ActivityUserState {
  NOT_PAID = 0,
  PAID_OUT = 1,
  EXEMPTED = 2,
}

export enum SchedulerTaskType {
  NOTIFICATIONS = 0,
}

export enum SchedulerRepeat {
  NONE = 0,
  DAILY = 1,
  WEEKLY = 2,
  MONTHLY = 3,
  YEARLY = 4,
}

export enum FileType {
  PROCEEDING = 0,
  PRESENTATIONS = 1,
}

export enum PowerState {
  PENDING = 0,
  APPROVED = 1,
  REJECTED = 2,
}

export enum SavingAccountState {
  ACTIVE = 0,
  CLOSED = 1,
}

export enum EmailTemplate {
  USER_ACTIVATION = 1,
  CHANGE_STATE_LOAN_APPROVED = 2,
  CHANGE_STATE_LOAN_DENIED = 3,
  POWER_APPROVED = 4,
  TEST = 5,
  PASSWORD_RESET = 6,
}
