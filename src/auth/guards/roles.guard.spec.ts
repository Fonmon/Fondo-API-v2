import { InternalServerErrorException, Logger, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { DjangoUrlPattern, ResolvedViewName } from '../../common/http/django-url-conf';
import { DrfException } from '../../common/http/drf.exception';
import { IS_DJANGO_VIEW_KEY } from '../decorators/django-view.decorator';
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
function reflectorFor(metadata: {
  isPublic?: boolean;
  v1View?: string;
  isDjangoView?: boolean;
}): Reflector {
  return {
    getAllAndOverride: (key: string) =>
      key === IS_PUBLIC_KEY
        ? metadata.isPublic
        : key === V1_VIEW_KEY
          ? metadata.v1View
          : key === IS_DJANGO_VIEW_KEY
            ? metadata.isDjangoView
            : undefined,
  } as unknown as Reflector;
}

/**
 * The pattern `DjangoUrlResolverMiddleware` would have attached (condition **C20**). Only
 * `view` matters to the guard.
 */
function route(view: ResolvedViewName | null): DjangoUrlPattern {
  return { regex: /^never$/, view, drf: null };
}

/**
 * `resolvedView` stands in for `request.djangoRoute`. It defaults to `metadata.v1View`
 * because *agreeing* is the normal case; the cells that matter to C20 set it explicitly.
 */
function contextFor(
  method: string,
  authUser?: AuthenticatedUser,
  djangoRoute?: DjangoUrlPattern,
): ExecutionContext {
  return {
    getType: () => 'http',
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => ({
      getRequest: () => ({ method, authUser, djangoRoute, originalUrl: '/probe' }),
    }),
  } as unknown as ExecutionContext;
}

/** The common case: the URL table and the controller name the same v1 view. */
function agreeing(
  view: ResolvedViewName,
  method: string,
  authUser?: AuthenticatedUser,
): ExecutionContext {
  return contextFor(method, authUser, route(view));
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
      expect(() => guard.canActivate(agreeing('LoanView', 'DELETE', user(Role.ADMIN)))).toThrow(
        DrfException,
      );
    });

    it('403s an authenticated user with no fondo_api_userprofile row', () => {
      const guard = new RolesGuard(reflectorFor({ v1View: 'LoanView' }));
      try {
        guard.canActivate(agreeing('LoanView', 'GET', user(null)));
        throw new Error('expected a 403');
      } catch (error) {
        expect((error as DrfException).getStatus()).toBe(403);
      }
    });
  });

  describe('role rules', () => {
    it.each(ALL_ROLES)('allows role %d on LoanView GET (rule 3)', (role) => {
      const guard = new RolesGuard(reflectorFor({ v1View: 'LoanView' }));
      expect(guard.canActivate(agreeing('LoanView', 'GET', user(role)))).toBe(true);
    });

    it.each([
      [Role.ADMIN, true],
      [Role.PRESIDENT, false],
      [Role.TREASURER, true],
      [Role.MEMBER, false],
    ] as const)('LoanView PATCH (rule [0,2]) for role %d -> %s', (role, allowed) => {
      const guard = new RolesGuard(reflectorFor({ v1View: 'LoanView' }));
      if (allowed) {
        expect(guard.canActivate(agreeing('LoanView', 'PATCH', user(role)))).toBe(true);
      } else {
        expect(() => guard.canActivate(agreeing('LoanView', 'PATCH', user(role)))).toThrow(
          DrfException,
        );
      }
    });
  });

  // ---------------------------------------------------------------------------
  // C20 / S2 — the view identity comes from the URL table, not from the Nest route
  // ---------------------------------------------------------------------------

  describe('C20 — the guard authorises on the view Django’s resolver picked', () => {
    let logged: string[];

    beforeEach(() => {
      logged = [];
      jest.spyOn(Logger.prototype, 'error').mockImplementation((message: unknown) => {
        logged.push(String(message));
      });
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('500s when the resolved view and the declared @V1View disagree', () => {
      // The Phase 3 case, made concrete. v1 resolves `DELETE /api/user/power` to
      // `UserAppsView` — measured live, `Allow: POST, OPTIONS` — which declares no DELETE and
      // is therefore a 403 for every role including ADMIN. A `:id`-first Nest controller
      // would hand it to `UserDetailView.DELETE`, where role <= 0 lets an ADMIN through.
      const guard = new RolesGuard(reflectorFor({ v1View: 'UserDetailView' }));

      expect(() =>
        guard.canActivate(contextFor('DELETE', user(Role.ADMIN), route('UserAppsView'))),
      ).toThrow(InternalServerErrorException);
      expect(logged.join('\n')).toContain("resolves to 'UserAppsView'");
      expect(logged.join('\n')).toContain("@V1View('UserDetailView')");
    });

    it('does not silently substitute the resolved view’s rules for the declared one’s', () => {
      // The tempting alternative — evaluate `UserAppsView`'s rules and 403 — would match v1's
      // status while still running the wrong handler. A 500 is the honest answer to "these
      // two mappings disagree".
      const guard = new RolesGuard(reflectorFor({ v1View: 'UserDetailView' }));

      try {
        guard.canActivate(contextFor('DELETE', user(Role.ADMIN), route('UserAppsView')));
        throw new Error('expected a 500');
      } catch (error) {
        expect(error).not.toBeInstanceOf(DrfException);
      }
    });

    it('500s a guarded route that resolves to a v2-only pattern (view: null)', () => {
      const guard = new RolesGuard(reflectorFor({ v1View: 'LoanView' }));

      expect(() => guard.canActivate(contextFor('GET', user(Role.ADMIN), route(null)))).toThrow(
        InternalServerErrorException,
      );
      expect(logged.join('\n')).toContain('no v1 view');
    });

    it('403s — never allows — when the URL layer left no resolved route at all', () => {
      const guard = new RolesGuard(reflectorFor({ v1View: 'LoanView' }));

      // `LoanView.GET` is rule 3, i.e. allowed for every role; the only reason this denies is
      // that nothing established which v1 view answers.
      expect(() => guard.canActivate(contextFor('GET', user(Role.MEMBER)))).toThrow(DrfException);
      expect(logged.join('\n')).toContain('no resolved v1 route');
    });

    it('does not log or throw for a controller that simply has no @V1View', () => {
      // That is v1's own `KeyError` path, not a v2 wiring bug: 403, quietly.
      const guard = new RolesGuard(reflectorFor({}));

      expect(() => guard.canActivate(contextFor('GET', user(Role.ADMIN)))).toThrow(DrfException);
      expect(logged).toEqual([]);
    });

    it('allows when the two agree, which is the whole point of the check being cheap', () => {
      const guard = new RolesGuard(reflectorFor({ v1View: 'UserAppsView' }));

      expect(guard.canActivate(agreeing('UserAppsView', 'POST', user(Role.MEMBER)))).toBe(true);
    });
  });

  it('does nothing outside an HTTP context', () => {
    const guard = new RolesGuard(reflectorFor({}));
    const context = { getType: () => 'ws' } as unknown as ExecutionContext;
    expect(guard.canActivate(context)).toBe(true);
  });

  /**
   * Parity finding **F3**, permission half. A `django.contrib.auth` view has no
   * `permission_classes` for `permission_classes = []` to clear — DRF is not in its stack —
   * so an anonymous request must reach it, and so must an authenticated one, with the same
   * result. The exemption is granted only when the URL table agrees the route has no DRF
   * layer; otherwise the guard runs, which is the fail-closed direction.
   */
  describe('F3 — a plain Django view is not permission-checked either', () => {
    const djangoRoute = (): DjangoUrlPattern => route('PasswordResetView');

    it('lets an anonymous request through, with no 401', () => {
      const guard = new RolesGuard(reflectorFor({ isDjangoView: true }));

      expect(guard.canActivate(contextFor('GET', undefined, djangoRoute()))).toBe(true);
    });

    it('lets an authenticated request through without consulting the role matrix', () => {
      const guard = new RolesGuard(reflectorFor({ isDjangoView: true }));

      for (const role of ALL_ROLES) {
        expect(guard.canActivate(contextFor('PUT', user(role), djangoRoute()))).toBe(true);
      }
    });

    it('ignores the decorator on a DRF route — the exemption needs both halves', () => {
      const guard = new RolesGuard(reflectorFor({ isDjangoView: true, v1View: 'UserView' }));
      const drfRoute: DjangoUrlPattern = {
        regex: /^api\/user\/?$/,
        view: 'UserView',
        drf: { allow: 'GET, POST, PATCH, HEAD, OPTIONS', varyAccept: true },
      };

      // `UserView.POST` is ADMIN-only, so a MEMBER must still be refused.
      expect(() => guard.canActivate(contextFor('POST', user(Role.MEMBER), drfRoute))).toThrow(
        DrfException,
      );
    });

    it('ignores the decorator when the URL layer resolved nothing', () => {
      const guard = new RolesGuard(reflectorFor({ isDjangoView: true }));

      expect(() => guard.canActivate(contextFor('GET', user(Role.ADMIN)))).toThrow(DrfException);
    });
  });
});
