import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DrfException } from '../../common/http/drf.exception';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { V1_VIEW_KEY } from '../decorators/v1-view.decorator';
import { ALL_ROLES, Role } from '../permissions/roles';
import type { AuthenticatedUser } from '../types/authenticated-user';
import { RolesGuard } from './roles.guard';

function user(role: Role | null, id = 7): AuthenticatedUser {
  return {
    id,
    username: 'a@b.com',
    email: 'a@b.com',
    isActive: true,
    profile: role === null ? null : { role, identification: 99999n },
  };
}

/**
 * A Reflector stub keyed the way `getAllAndOverride` is called: handler first, then class.
 */
function reflectorFor(metadata: { isPublic?: boolean; v1View?: string }): Reflector {
  return {
    getAllAndOverride: (key: string) =>
      key === IS_PUBLIC_KEY ? metadata.isPublic : key === V1_VIEW_KEY ? metadata.v1View : undefined,
  } as unknown as Reflector;
}

function contextFor(method: string, authUser?: AuthenticatedUser): ExecutionContext {
  return {
    getType: () => 'http',
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => ({ method, authUser }) }),
  } as unknown as ExecutionContext;
}

describe('RolesGuard (IsAuthenticated + APIRolePermission)', () => {
  describe('unauthenticated requests', () => {
    it("401s with DRF's NotAuthenticated body and the WWW-Authenticate challenge", () => {
      const guard = new RolesGuard(reflectorFor({ v1View: 'LoanView' }));
      try {
        guard.canActivate(contextFor('GET'));
        throw new Error('expected a DrfException');
      } catch (error) {
        expect(error).toBeInstanceOf(DrfException);
        const drf = error as DrfException;
        // `APIView.permission_denied`: authenticators exist but none succeeded ->
        // NotAuthenticated, and `handle_exception` keeps it a 401 because
        // TokenAuthentication.authenticate_header() returns 'Token'.
        expect(drf.getStatus()).toBe(401);
        expect(drf.drfBody).toEqual({
          detail: 'Authentication credentials were not provided.',
        });
        expect(drf.drfHeaders).toEqual({ 'WWW-Authenticate': 'Token' });
      }
    });

    it('401s before consulting the role matrix, even on a rule-less route', () => {
      const guard = new RolesGuard(reflectorFor({}));
      expect(() => guard.canActivate(contextFor('GET'))).toThrow(DrfException);
      try {
        guard.canActivate(contextFor('GET'));
      } catch (error) {
        expect((error as DrfException).getStatus()).toBe(401);
      }
    });
  });

  describe("@Public() — v1's permission_classes = []", () => {
    it('allows an anonymous request', () => {
      const guard = new RolesGuard(reflectorFor({ isPublic: true }));
      expect(guard.canActivate(contextFor('POST'))).toBe(true);
    });

    it('allows an authenticated request without consulting the matrix', () => {
      const guard = new RolesGuard(reflectorFor({ isPublic: true }));
      expect(guard.canActivate(contextFor('POST', user(Role.MEMBER)))).toBe(true);
    });
  });

  describe('default deny for routes with no rule', () => {
    it('403s an authenticated ADMIN on a controller with no @V1View', () => {
      // Phase 1 parity criterion: "an authenticated request to a rule-less route -> 403 in
      // both". This is the test that proves an unregistered route fails closed.
      const guard = new RolesGuard(reflectorFor({}));
      for (const role of ALL_ROLES) {
        try {
          guard.canActivate(contextFor('GET', user(role)));
          throw new Error(`expected a 403 for role ${role}`);
        } catch (error) {
          expect(error).toBeInstanceOf(DrfException);
          const drf = error as DrfException;
          expect(drf.getStatus()).toBe(403);
          expect(drf.drfBody).toEqual({
            detail: 'You do not have permission to perform this action.',
          });
          // PermissionDenied carries no WWW-Authenticate.
          expect(drf.drfHeaders).toEqual({});
        }
      }
    });

    it('403s a @V1View name that is registered but has no rule for the method', () => {
      const guard = new RolesGuard(reflectorFor({ v1View: 'LoanView' }));
      expect(() => guard.canActivate(contextFor('DELETE', user(Role.ADMIN)))).toThrow(DrfException);
    });

    it('403s an authenticated user with no fondo_api_userprofile row', () => {
      const guard = new RolesGuard(reflectorFor({ v1View: 'LoanView' }));
      try {
        guard.canActivate(contextFor('GET', user(null)));
        throw new Error('expected a 403');
      } catch (error) {
        expect((error as DrfException).getStatus()).toBe(403);
      }
    });
  });

  describe('role rules', () => {
    it.each(ALL_ROLES)('allows role %d on LoanView GET (rule 3)', (role) => {
      const guard = new RolesGuard(reflectorFor({ v1View: 'LoanView' }));
      expect(guard.canActivate(contextFor('GET', user(role)))).toBe(true);
    });

    it.each([
      [Role.ADMIN, true],
      [Role.PRESIDENT, false],
      [Role.TREASURER, true],
      [Role.MEMBER, false],
    ] as const)('LoanView PATCH (rule [0,2]) for role %d -> %s', (role, allowed) => {
      const guard = new RolesGuard(reflectorFor({ v1View: 'LoanView' }));
      if (allowed) {
        expect(guard.canActivate(contextFor('PATCH', user(role)))).toBe(true);
      } else {
        expect(() => guard.canActivate(contextFor('PATCH', user(role)))).toThrow(DrfException);
      }
    });
  });

  it('does nothing outside an HTTP context', () => {
    const guard = new RolesGuard(reflectorFor({}));
    const context = { getType: () => 'ws' } as unknown as ExecutionContext;
    expect(guard.canActivate(context)).toBe(true);
  });
});
