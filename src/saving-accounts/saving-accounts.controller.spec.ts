import { Test, TestingModule } from '@nestjs/testing';
import { SavingAccountsController } from './saving-accounts.controller';
import { SavingAccountsService } from './saving-accounts.service';

describe('SavingAccountsController', () => {
  let controller: SavingAccountsController;
  let service: jest.Mocked<SavingAccountsService>;

  const mockUser = {
    id: 1,
    email: 'admin@example.com',
    firstName: 'Admin',
    lastName: 'User',
    role: 0,
    profileId: 1,
  };

  const memberUser = { ...mockUser, role: 3 };

  const mockAccount = {
    id: 1,
    value: 10000,
    created_at: '1 ene. 2026',
    state: 0,
    user_full_name: 'John Doe',
    end_date: '31 dic. 2026',
  };

  beforeEach(async () => {
    const mockService = {
      createAccount: jest.fn().mockResolvedValue(mockAccount),
      getAccounts: jest.fn().mockResolvedValue({ list: [mockAccount], count: 1, num_pages: 1 }),
      updateAccount: jest.fn().mockResolvedValue(mockAccount),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [SavingAccountsController],
      providers: [{ provide: SavingAccountsService, useValue: mockService }],
    }).compile();

    controller = module.get<SavingAccountsController>(SavingAccountsController);
    service = module.get(SavingAccountsService);
  });

  it('should get accounts for admin (all accounts)', async () => {
    await controller.getAccounts(undefined, undefined, { user: mockUser } as any);
    expect(service.getAccounts).toHaveBeenCalledWith(mockUser.profileId, null, true, null, false);
  });

  it('should get accounts for member (own accounts only)', async () => {
    await controller.getAccounts('1', '0', { user: memberUser } as any);
    expect(service.getAccounts).toHaveBeenCalledWith(memberUser.profileId, 1, false, 0, true);
  });

  it('should create account', async () => {
    const result = await controller.createAccount({ end_date: '2026-12-31' }, { user: mockUser } as any);
    expect(result).toEqual(mockAccount);
  });

  it('should update account', async () => {
    const result = await controller.updateAccount({ id: 1, state: 1, value: 20000 });
    expect(result).toEqual(mockAccount);
  });
});
