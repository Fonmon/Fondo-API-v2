import { AuthService, UserContext } from './auth.service';
import * as util from './password.util';

const mockPrisma = {
  auth_user: {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    update: jest.fn(),
  },
  authtoken_token: {
    upsert: jest.fn(),
    findUnique: jest.fn(),
  },
};

const mockMail = { sendMail: jest.fn() };
const mockConfig = { get: jest.fn() };

function buildService() {
  return new AuthService(
    mockPrisma as any,
    mockMail as any,
    mockConfig as any,
  );
}

const activeUser = {
  id: 1,
  username: 'user@example.com',
  email: 'user@example.com',
  password: 'pbkdf2_sha256$...',
  first_name: 'John',
  last_name: 'Doe',
  is_active: true,
  fondo_api_userprofile: { role: 3, user_ptr_id: 1 },
};

beforeEach(() => jest.clearAllMocks());

describe('login', () => {
  it('returns null when user does not exist', async () => {
    mockPrisma.auth_user.findUnique.mockResolvedValue(null);
    const svc = buildService();
    expect(await svc.login('x', 'y')).toBeNull();
  });

  it('returns null when user is inactive', async () => {
    mockPrisma.auth_user.findUnique.mockResolvedValue({
      ...activeUser,
      is_active: false,
    });
    const svc = buildService();
    expect(await svc.login('x', 'y')).toBeNull();
  });

  it('returns null when password is wrong', async () => {
    mockPrisma.auth_user.findUnique.mockResolvedValue(activeUser);
    jest.spyOn(util, 'verifyPassword').mockResolvedValue(false);
    const svc = buildService();
    expect(await svc.login('user@example.com', 'wrong')).toBeNull();
  });

  it('returns token and upserts authtoken on success', async () => {
    mockPrisma.auth_user.findUnique.mockResolvedValue(activeUser);
    jest.spyOn(util, 'verifyPassword').mockResolvedValue(true);
    mockPrisma.authtoken_token.upsert.mockResolvedValue({});
    const svc = buildService();
    const result = await svc.login('user@example.com', 'correct');
    expect(result).toHaveProperty('token');
    expect(typeof result?.token).toBe('string');
    expect(result?.token).toHaveLength(40);
    expect(mockPrisma.authtoken_token.upsert).toHaveBeenCalledTimes(1);
  });
});

describe('validateToken', () => {
  it('returns null when token does not exist', async () => {
    mockPrisma.authtoken_token.findUnique.mockResolvedValue(null);
    const svc = buildService();
    expect(await svc.validateToken('badkey')).toBeNull();
  });

  it('returns null when user is inactive', async () => {
    mockPrisma.authtoken_token.findUnique.mockResolvedValue({
      auth_user: { ...activeUser, is_active: false },
    });
    const svc = buildService();
    expect(await svc.validateToken('key')).toBeNull();
  });

  it('returns null when user has no profile', async () => {
    mockPrisma.authtoken_token.findUnique.mockResolvedValue({
      auth_user: { ...activeUser, fondo_api_userprofile: null },
    });
    const svc = buildService();
    expect(await svc.validateToken('key')).toBeNull();
  });

  it('returns UserContext on valid token', async () => {
    mockPrisma.authtoken_token.findUnique.mockResolvedValue({
      auth_user: activeUser,
    });
    const svc = buildService();
    const ctx = await svc.validateToken('validkey');
    expect(ctx).toEqual<UserContext>({
      id: 1,
      email: 'user@example.com',
      firstName: 'John',
      lastName: 'Doe',
      role: 3,
      profileId: 1,
    });
  });
});

describe('requestPasswordReset', () => {
  it('does nothing when user not found', async () => {
    mockPrisma.auth_user.findFirst.mockResolvedValue(null);
    const svc = buildService();
    await svc.requestPasswordReset('unknown@example.com');
    expect(mockPrisma.auth_user.update).not.toHaveBeenCalled();
    expect(mockMail.sendMail).not.toHaveBeenCalled();
  });

  it('stores token and sends email when user exists', async () => {
    mockPrisma.auth_user.findFirst.mockResolvedValue(activeUser);
    mockPrisma.auth_user.update.mockResolvedValue({});
    mockMail.sendMail.mockResolvedValue(true);
    mockConfig.get.mockReturnValue('http://app.example.com');
    const svc = buildService();
    await svc.requestPasswordReset('user@example.com');
    expect(mockPrisma.auth_user.update).toHaveBeenCalledTimes(1);
    const updateData = mockPrisma.auth_user.update.mock.calls[0][0].data;
    expect(typeof updateData.password_reset_token).toBe('string');
    expect(updateData.password_reset_token).toHaveLength(50);
    expect(mockMail.sendMail).toHaveBeenCalledTimes(1);
  });
});

describe('confirmPasswordReset', () => {
  it('returns false when token not found', async () => {
    mockPrisma.auth_user.findFirst.mockResolvedValue(null);
    const svc = buildService();
    expect(await svc.confirmPasswordReset('badtoken', 'newpass')).toBe(false);
  });

  it('returns true, updates password, and clears token', async () => {
    mockPrisma.auth_user.findFirst.mockResolvedValue(activeUser);
    mockPrisma.auth_user.update.mockResolvedValue({});
    jest
      .spyOn(util, 'hashPassword')
      .mockResolvedValue('pbkdf2_sha256$600000$salt$hash');
    const svc = buildService();
    expect(await svc.confirmPasswordReset('goodtoken', 'newpass')).toBe(true);
    const updateData = mockPrisma.auth_user.update.mock.calls[0][0].data;
    expect(updateData.password_reset_token).toBeNull();
    expect(updateData.password).toBe('pbkdf2_sha256$600000$salt$hash');
  });
});
