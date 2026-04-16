import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from './roles.guard';
import { RoleRequirement } from './roles.decorator';

const reflector = new Reflector();

function makeContext(user?: { role: number }): ExecutionContext {
  const request = { user };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
}

beforeEach(() => jest.clearAllMocks());

describe('RolesGuard', () => {
  it('allows access when no role requirement is set', () => {
    const guard = new RolesGuard(reflector);
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);
    expect(guard.canActivate(makeContext({ role: 3 }))).toBe(true);
  });

  it('denies access when user is not on request', () => {
    const guard = new RolesGuard(reflector);
    const req: RoleRequirement = { maxRole: 3 };
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(req);
    expect(guard.canActivate(makeContext(undefined))).toBe(false);
  });

  it('allows ADMIN (role=0) when maxRole=3', () => {
    const guard = new RolesGuard(reflector);
    jest
      .spyOn(reflector, 'getAllAndOverride')
      .mockReturnValue({ maxRole: 3 } as RoleRequirement);
    expect(guard.canActivate(makeContext({ role: 0 }))).toBe(true);
  });

  it('allows MEMBER (role=3) when maxRole=3', () => {
    const guard = new RolesGuard(reflector);
    jest
      .spyOn(reflector, 'getAllAndOverride')
      .mockReturnValue({ maxRole: 3 } as RoleRequirement);
    expect(guard.canActivate(makeContext({ role: 3 }))).toBe(true);
  });

  it('denies MEMBER (role=3) when maxRole=0 (ADMIN only)', () => {
    const guard = new RolesGuard(reflector);
    jest
      .spyOn(reflector, 'getAllAndOverride')
      .mockReturnValue({ maxRole: 0 } as RoleRequirement);
    expect(guard.canActivate(makeContext({ role: 3 }))).toBe(false);
  });

  it('allows roles in exactRoles list', () => {
    const guard = new RolesGuard(reflector);
    jest
      .spyOn(reflector, 'getAllAndOverride')
      .mockReturnValue({ exactRoles: [0, 2] } as RoleRequirement);
    expect(guard.canActivate(makeContext({ role: 0 }))).toBe(true);
    expect(guard.canActivate(makeContext({ role: 2 }))).toBe(true);
  });

  it('denies roles not in exactRoles list', () => {
    const guard = new RolesGuard(reflector);
    jest
      .spyOn(reflector, 'getAllAndOverride')
      .mockReturnValue({ exactRoles: [0, 2] } as RoleRequirement);
    expect(guard.canActivate(makeContext({ role: 1 }))).toBe(false);
    expect(guard.canActivate(makeContext({ role: 3 }))).toBe(false);
  });
});
