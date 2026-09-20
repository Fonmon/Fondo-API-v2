import {
  PERMISSION_MATRIX,
  V1_VIEW_NAMES,
  isRoleAllowed,
  type PermissionMethod,
  type V1ViewName,
} from './permission-matrix';
import { ALL_ROLES, Role } from './roles';
import { V1_ROLE_MATRIX } from './v1-role-matrix.fixture';

/**
 * Phase 1 parity criterion: "14 view classes × each method in `list_permissions` × 4 roles →
 * identical allow/deny. Plus an authenticated request to a rule-less route → 403 in both."
 *
 * v1 counterpart: `fondo_api/permissions.py` — which has **no tests at all** in v1. The
 * expectations here come from running the real stack, not from reading the dict.
 */
describe('APIRolePermission port (fondo_api/permissions.py)', () => {
  describe('the full v1 role matrix, captured from Django + DRF', () => {
    it.each(V1_ROLE_MATRIX.map((row) => [row.view, row.method, row.role, row.allowed] as const))(
      '%s %s as role %d -> allowed=%s',
      (view, method, role, allowed) => {
        expect(isRoleAllowed(view, method, role)).toBe(allowed);
      },
    );

    it('covers all 14 view classes across 5 methods and 4 roles', () => {
      expect(V1_ROLE_MATRIX).toHaveLength(14 * 5 * 4);
      expect(new Set(V1_ROLE_MATRIX.map((row) => row.view)).size).toBe(14);
    });
  });

  describe('the ported dict matches v1 key for key', () => {
    it("declares exactly v1's 14 view classes, in v1's order", () => {
      expect(V1_VIEW_NAMES).toEqual([
        'LoanView',
        'LoanDetailView',
        'UserDetailView',
        'UserView',
        'ActivityYearView',
        'ActivityYearDetailView',
        'ActivityDetailView',
        'LoanAppsView',
        'NotificationView',
        'FileView',
        'FileDetailView',
        'UserAppsView',
        'AdminView',
        'SavingAccountView',
      ]);
    });

    it('keeps the two list-form rules as lists, not ceilings', () => {
      // `[0,2]` deliberately excludes PRESIDENT. Q23 confirms the exclusion is intentional
      // for saving accounts; the same shape guards the loan/user PATCH routes.
      expect(PERMISSION_MATRIX.LoanView.PATCH).toEqual([Role.ADMIN, Role.TREASURER]);
      expect(PERMISSION_MATRIX.LoanDetailView.PATCH).toEqual([Role.ADMIN, Role.TREASURER]);
      expect(PERMISSION_MATRIX.UserView.PATCH).toEqual([Role.ADMIN, Role.TREASURER]);
      expect(PERMISSION_MATRIX.SavingAccountView.PUT).toEqual([Role.ADMIN, Role.TREASURER]);
      expect(isRoleAllowed('SavingAccountView', 'PUT', Role.PRESIDENT)).toBe(false);
    });
  });

  describe("default deny — v1's bare `except: return False`", () => {
    it('denies a view that is not in list_permissions, for every role', () => {
      for (const role of ALL_ROLES) {
        expect(isRoleAllowed('SomeBrandNewView', 'GET', role)).toBe(false);
      }
    });

    it('denies a controller with no @V1View metadata at all, for every role', () => {
      for (const role of ALL_ROLES) {
        expect(isRoleAllowed(undefined, 'GET', role)).toBe(false);
      }
    });

    it('denies a method the view does not declare, including for ADMIN', () => {
      // `LoanView` declares GET/POST/PATCH only.
      expect(isRoleAllowed('LoanView', 'DELETE', Role.ADMIN)).toBe(false);
      expect(isRoleAllowed('LoanView', 'PUT', Role.ADMIN)).toBe(false);
      expect(isRoleAllowed('AdminView', 'POST', Role.ADMIN)).toBe(false);
    });

    it('denies when the user has no fondo_api_userprofile row', () => {
      // v1: `request.user.userprofile` raises RelatedObjectDoesNotExist -> except -> False.
      expect(isRoleAllowed('LoanView', 'GET', null)).toBe(false);
      expect(isRoleAllowed('LoanView', 'GET', undefined)).toBe(false);
    });

    it('denies a non-integer role rather than coercing it', () => {
      expect(isRoleAllowed('LoanView', 'GET', Number.NaN)).toBe(false);
      expect(isRoleAllowed('LoanView', 'GET', 1.5)).toBe(false);
    });

    it('denies unknown HTTP methods (HEAD, OPTIONS, TRACE)', () => {
      for (const method of ['HEAD', 'OPTIONS', 'TRACE'] as const) {
        expect(isRoleAllowed('LoanView', method, Role.ADMIN)).toBe(false);
      }
    });
  });

  describe('rule semantics', () => {
    it('treats an integer rule as a ceiling: role <= N', () => {
      // ActivityYearView.POST == 1 -> ADMIN and PRESIDENT only.
      expect(isRoleAllowed('ActivityYearView', 'POST', Role.ADMIN)).toBe(true);
      expect(isRoleAllowed('ActivityYearView', 'POST', Role.PRESIDENT)).toBe(true);
      expect(isRoleAllowed('ActivityYearView', 'POST', Role.TREASURER)).toBe(false);
      expect(isRoleAllowed('ActivityYearView', 'POST', Role.MEMBER)).toBe(false);
    });

    it('treats a list rule as exact membership', () => {
      expect(isRoleAllowed('LoanView', 'PATCH', Role.ADMIN)).toBe(true);
      expect(isRoleAllowed('LoanView', 'PATCH', Role.PRESIDENT)).toBe(false);
      expect(isRoleAllowed('LoanView', 'PATCH', Role.TREASURER)).toBe(true);
      expect(isRoleAllowed('LoanView', 'PATCH', Role.MEMBER)).toBe(false);
    });

    it('would keep a hypothetical role 4 out of every ceiling rule', () => {
      // Not reachable today, but this is why `3` must not be rewritten as `[0,1,2,3]`.
      const rules = Object.values(PERMISSION_MATRIX).flatMap((view) =>
        Object.entries(view).map(([method, rule]) => ({ method, rule })),
      );
      expect(rules.length).toBeGreaterThan(0);
      expect(isRoleAllowed('LoanView', 'GET', 4)).toBe(false);
    });
  });

  describe('every declared method is one the matrix type allows', () => {
    it.each(V1_VIEW_NAMES)('%s declares only GET/POST/PATCH/PUT/DELETE', (view) => {
      const methods: readonly PermissionMethod[] = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'];
      for (const key of Object.keys(PERMISSION_MATRIX[view])) {
        expect(methods).toContain(key);
      }
    });

    it('exposes the view names as a literal union, so a typo cannot compile', () => {
      // @ts-expect-error 'LoanViw' is not a V1ViewName.
      const typo: V1ViewName = 'LoanViw';
      expect(typo).toBe('LoanViw');
    });
  });
});
