import { BadRequestException } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

const mockAuth = {
  login: jest.fn(),
  requestPasswordReset: jest.fn(),
  confirmPasswordReset: jest.fn(),
} as unknown as AuthService;

function buildController() {
  return new AuthController(mockAuth);
}

beforeEach(() => jest.clearAllMocks());

describe('POST /api-token-auth', () => {
  it('returns token on valid credentials', async () => {
    (mockAuth.login as jest.Mock).mockResolvedValue({ token: 'abc123' });
    const ctrl = buildController();
    const result = await ctrl.login({ username: 'u', password: 'p' } as any);
    expect(result).toEqual({ token: 'abc123' });
  });

  it('throws BadRequestException on invalid credentials', async () => {
    (mockAuth.login as jest.Mock).mockResolvedValue(null);
    const ctrl = buildController();
    await expect(
      ctrl.login({ username: 'u', password: 'wrong' } as any),
    ).rejects.toThrow(BadRequestException);
  });
});

describe('POST /password_reset', () => {
  it('calls requestPasswordReset and returns void', async () => {
    (mockAuth.requestPasswordReset as jest.Mock).mockResolvedValue(undefined);
    const ctrl = buildController();
    await ctrl.requestReset({ email: 'user@example.com' } as any);
    expect(mockAuth.requestPasswordReset).toHaveBeenCalledWith(
      'user@example.com',
    );
  });
});

describe('POST /password_reset/confirm', () => {
  it('calls confirmPasswordReset and returns void', async () => {
    (mockAuth.confirmPasswordReset as jest.Mock).mockResolvedValue(true);
    const ctrl = buildController();
    await ctrl.confirmReset({ token: 'tok', new_password: 'newpass' } as any);
    expect(mockAuth.confirmPasswordReset).toHaveBeenCalledWith(
      'tok',
      'newpass',
    );
  });
});
