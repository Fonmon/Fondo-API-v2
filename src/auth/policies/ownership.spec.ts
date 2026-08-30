import { DrfException } from '../../common/http/drf.exception';
import { Role } from '../permissions/roles';
import type { AuthenticatedUser } from '../types/authenticated-user';
import { SELF_USER_ID, assertOwnership, isSelf, resolveUserId } from './ownership';

function actor(role: Role, id = 7): AuthenticatedUser {
  return {
    id,
    username: 'a@b.com',
    email: 'a@b.com',
    isActive: true,
    profile: { role, identification: 99999n },
  };
}

describe('ownership primitives', () => {
  describe("resolveUserId (v1's `if id == -1: id = request.user.id`)", () => {
    it('substitutes the caller for -1 where the v1 handler does', () => {
      expect(resolveUserId(SELF_USER_ID, actor(Role.MEMBER), true)).toBe(7);
    });

    it('leaves -1 alone where the v1 handler does not substitute', () => {
      // `UserDetailView.patch` and `.delete` pass the raw id through; only `.get` substitutes.
      expect(resolveUserId(SELF_USER_ID, actor(Role.MEMBER), false)).toBe(-1);
    });

    it('passes other ids through unchanged', () => {
      expect(resolveUserId(42, actor(Role.MEMBER), true)).toBe(42);
      expect(resolveUserId(-2, actor(Role.MEMBER), true)).toBe(-2);
    });
  });

  describe('isSelf', () => {
    it('compares resolved ids', () => {
      expect(isSelf(actor(Role.MEMBER), 7)).toBe(true);
      expect(isSelf(actor(Role.MEMBER), 8)).toBe(false);
      // Unresolved sentinel never matches — resolve first.
      expect(isSelf(actor(Role.MEMBER), SELF_USER_ID)).toBe(false);
    });
  });

  describe('assertOwnership', () => {
    it('allows the owner', () => {
      expect(() => assertOwnership(actor(Role.MEMBER), 7)).not.toThrow();
    });

    it('denies a non-owner with no elevated role', () => {
      expect(() => assertOwnership(actor(Role.MEMBER), 8)).toThrow(DrfException);
    });

    it('allows the elevated roles a caller passes in (Phase 4 D10: owner + [0,1,2])', () => {
      const privileged = [Role.ADMIN, Role.PRESIDENT, Role.TREASURER];
      expect(() => assertOwnership(actor(Role.PRESIDENT), 8, privileged)).not.toThrow();
      expect(() => assertOwnership(actor(Role.MEMBER), 8, privileged)).toThrow(DrfException);
    });

    it('denies a caller with no profile row', () => {
      const orphan: AuthenticatedUser = {
        id: 7,
        username: 'root',
        email: '',
        isActive: true,
        profile: null,
      };
      expect(() => assertOwnership(orphan, 8, [Role.ADMIN])).toThrow(DrfException);
      expect(() => assertOwnership(orphan, 7, [Role.ADMIN])).not.toThrow();
    });

    it("denies with DRF's generic 403 so it cannot be used to probe for user ids", () => {
      try {
        assertOwnership(actor(Role.MEMBER), 8);
        throw new Error('expected a 403');
      } catch (error) {
        expect((error as DrfException).getStatus()).toBe(403);
        expect((error as DrfException).drfBody).toEqual({
          detail: 'You do not have permission to perform this action.',
        });
      }
    });
  });
});
