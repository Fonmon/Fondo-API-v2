import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { LoansController } from './loans.controller';
import { LoansService } from './loans.service';

describe('LoansController', () => {
  let controller: LoansController;
  let service: jest.Mocked<LoansService>;

  const mockUser = {
    id: 1,
    email: 'admin@example.com',
    firstName: 'Admin',
    lastName: 'User',
    role: 0,
    profileId: 1,
  };

  const memberUser = { ...mockUser, role: 3 };

  const mockLoanResult = {
    id: 1,
    value: 100000,
    timelimit: 12,
    disbursement_date: '20 mar. 2026',
    payment: 0,
    created_at: '20 mar. 2026',
    fee: 0,
    comments: null,
    state: 0,
    user_full_name: 'John Doe',
    rate: '0.020',
    is_refinanced: false,
    refinanced_loan: null,
    user_id: 1,
    disbursement_value: null,
  };

  beforeEach(async () => {
    const mockService = {
      createLoan: jest.fn().mockResolvedValue(mockLoanResult),
      getLoans: jest.fn().mockResolvedValue({ list: [mockLoanResult], count: 1, num_pages: 1 }),
      getLoan: jest.fn().mockResolvedValue({ loan: mockLoanResult, loan_detail: [] }),
      updateLoan: jest.fn().mockResolvedValue(mockLoanResult),
      bulkUpdateLoans: jest.fn().mockResolvedValue(undefined),
      paymentProjection: jest.fn().mockResolvedValue({ interests: 500, total_payment: 100500 }),
      refinanceLoan: jest.fn().mockResolvedValue(mockLoanResult),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [LoansController],
      providers: [{ provide: LoansService, useValue: mockService }],
    }).compile();

    controller = module.get<LoansController>(LoansController);
    service = module.get(LoansService);
  });

  it('should get loans for admin (all loans)', async () => {
    await controller.getLoans(undefined, undefined, { user: mockUser } as any);
    expect(service.getLoans).toHaveBeenCalledWith(mockUser.profileId, null, true, 4, false);
  });

  it('should get loans for member (own loans only)', async () => {
    await controller.getLoans('1', '0', { user: memberUser } as any);
    expect(service.getLoans).toHaveBeenCalledWith(memberUser.profileId, 1, false, 0, true);
  });

  it('should create loan', async () => {
    const result = await controller.createLoan({ value: 100000, timelimit: 12, disbursement_date: '2026-03-20', payment: 0, fee: 0 }, { user: mockUser } as any);
    expect(result).toEqual(mockLoanResult);
  });

  it('should throw 406 HttpException when quota insufficient', async () => {
    service.createLoan.mockResolvedValue(null);
    await expect(controller.createLoan({ value: 100000 }, { user: mockUser } as any)).rejects.toMatchObject({ status: 406 });
  });

  it('should bulk update loans with file', async () => {
    const mockFile = { buffer: Buffer.from('data') } as Express.Multer.File;
    await controller.bulkUpdateLoans(mockFile);
    expect(service.bulkUpdateLoans).toHaveBeenCalled();
  });

  it('should throw BadRequestException when no file for bulk update', async () => {
    await expect(controller.bulkUpdateLoans(undefined as any)).rejects.toThrow(BadRequestException);
  });

  it('should get loan by id', async () => {
    const result = await controller.getLoan('1');
    expect(result).toHaveProperty('loan');
  });

  it('should throw NotFoundException when loan not found', async () => {
    service.getLoan.mockResolvedValue(null);
    await expect(controller.getLoan('999')).rejects.toThrow(NotFoundException);
  });

  it('should update loan', async () => {
    const result = await controller.updateLoan('1', { state: 1 });
    expect(result).toEqual(mockLoanResult);
  });

  it('should throw NotFoundException when loan not found on update', async () => {
    service.updateLoan.mockResolvedValue(null);
    await expect(controller.updateLoan('999', { state: 1 })).rejects.toThrow(NotFoundException);
  });

  it('should handle paymentProjection app', async () => {
    const result = await controller.handleApp('1', 'paymentProjection', { to_date: '2026-05-20' }, { user: mockUser } as any);
    expect(result).toHaveProperty('interests');
  });

  it('should throw NotFoundException when paymentProjection returns null', async () => {
    service.paymentProjection.mockResolvedValue(null);
    await expect(controller.handleApp('1', 'paymentProjection', { to_date: '2026-05-20' }, { user: mockUser } as any)).rejects.toThrow(NotFoundException);
  });

  it('should handle refinance app', async () => {
    const result = await controller.handleApp('1', 'refinance', { value: 120000 }, { user: mockUser } as any);
    expect(result).toHaveProperty('id');
  });

  it('should throw BadRequestException when refinance fails', async () => {
    service.refinanceLoan.mockResolvedValue(null);
    await expect(controller.handleApp('1', 'refinance', {}, { user: mockUser } as any)).rejects.toThrow(BadRequestException);
  });

  it('should throw NotFoundException for unknown app', async () => {
    await expect(controller.handleApp('1', 'unknown', {}, { user: mockUser } as any)).rejects.toThrow(NotFoundException);
  });
});
