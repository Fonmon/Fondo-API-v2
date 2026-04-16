import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { IS_PUBLIC_KEY } from './public.decorator';

const mockAuth = { validateToken: jest.fn() } as unknown as AuthService;
const reflector = new Reflector();

function makeContext(
  headers: Record<string, string> = {},
  isPublic = false,
): ExecutionContext {
  const request = { headers, user: undefined as unknown };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => ({}),
    getClass: () => ({}),
    _request: request,
  } as unknown as ExecutionContext;
}

beforeEach(() => jest.clearAllMocks());

describe('AuthGuard', () => {
  it('passes through @Public() routes without checking token', async () => {
    const guard = new AuthGuard(mockAuth, reflector);
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);
    const ctx = makeContext({}, true);
    expect(await guard.canActivate(ctx)).toBe(true);
    expect((mockAuth as any).validateToken).not.toHaveBeenCalled();
  });

  it('throws UnauthorizedException when Authorization header is missing', async () => {
    const guard = new AuthGuard(mockAuth, reflector);
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    const ctx = makeContext({});
    await expect(guard.canActivate(ctx)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('throws UnauthorizedException when header does not start with "Token "', async () => {
    const guard = new AuthGuard(mockAuth, reflector);
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    const ctx = makeContext({ authorization: 'Bearer sometoken' });
    await expect(guard.canActivate(ctx)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('throws UnauthorizedException when token is invalid', async () => {
    const guard = new AuthGuard(mockAuth, reflector);
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    (mockAuth.validateToken as jest.Mock).mockResolvedValue(null);
    const ctx = makeContext({ authorization: 'Token badkey' });
    await expect(guard.canActivate(ctx)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('attaches user to request and returns true for valid token', async () => {
    const guard = new AuthGuard(mockAuth, reflector);
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    const userCtx = {
      id: 1,
      email: 'a@b.com',
      firstName: 'A',
      lastName: 'B',
      role: 3,
      profileId: 1,
    };
    (mockAuth.validateToken as jest.Mock).mockResolvedValue(userCtx);
    const request = { headers: { authorization: 'Token validkey' } } as any;
    const ctx = {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as unknown as ExecutionContext;

    const result = await guard.canActivate(ctx);
    expect(result).toBe(true);
    expect(request.user).toBe(userCtx);
  });
});
