import { DrfException } from '../../common/http/drf.exception';
import { ALL_ROLES, Role } from '../permissions/roles';
import type { AuthenticatedUser } from '../types/authenticated-user';
import {
  ROLE_FIELD,
  assertSectionWritable,
  assertUserPatchAllowed,
  canWriteSection,
  changedFields,
  userPatchAllowlist,
  type UserSection,
} from './user-patch.policy';

const ME = 7;
const SOMEONE_ELSE = 99;

function actor(role: Role): AuthenticatedUser {
  return {
    id: ME,
    username: 'a@b.com',
    email: 'a@b.com',
    isActive: true,
    profile: { role, identification: 99999n },
  };
}

const SECTIONS: readonly UserSection[] = ['personal', 'finance', 'preferences'];

/**
 * The §5 D1 table, transcribed as data so the test *is* the specification:
 *
 * | Role | Own profile | Other users | `role` field | `finance` section |
 * |---|---|---|---|---|
 * | 0 ADMIN | ✅ | ✅ any section | ✅ only ADMIN | ✅ any user |
 * | 1 PRESIDENT | ✅ personal + preferences | ❌ | ❌ | ❌ |
 * | 2 TREASURER | ✅ personal + preferences | finance only | ❌ | ✅ any user |
 * | 3 MEMBER | ✅ personal + preferences | ❌ | ❌ | ❌ |
 */
const D1: readonly {
  role: Role;
  target: 'self' | 'other';
  section: UserSection;
  allowed: boolean;
}[] = [
  // ADMIN — everything, on anyone.
  { role: Role.ADMIN, target: 'self', section: 'personal', allowed: true },
  { role: Role.ADMIN, target: 'self', section: 'preferences', allowed: true },
  { role: Role.ADMIN, target: 'self', section: 'finance', allowed: true },
  { role: Role.ADMIN, target: 'other', section: 'personal', allowed: true },
  { role: Role.ADMIN, target: 'other', section: 'preferences', allowed: true },
  { role: Role.ADMIN, target: 'other', section: 'finance', allowed: true },

  // PRESIDENT — self-service only, and no finance even on their own row.
  { role: Role.PRESIDENT, target: 'self', section: 'personal', allowed: true },
  { role: Role.PRESIDENT, target: 'self', section: 'preferences', allowed: true },
  { role: Role.PRESIDENT, target: 'self', section: 'finance', allowed: false },
  { role: Role.PRESIDENT, target: 'other', section: 'personal', allowed: false },
  { role: Role.PRESIDENT, target: 'other', section: 'preferences', allowed: false },
  { role: Role.PRESIDENT, target: 'other', section: 'finance', allowed: false },

  // TREASURER — self-service, plus finance on anyone.
  { role: Role.TREASURER, target: 'self', section: 'personal', allowed: true },
  { role: Role.TREASURER, target: 'self', section: 'preferences', allowed: true },
  { role: Role.TREASURER, target: 'self', section: 'finance', allowed: true },
  { role: Role.TREASURER, target: 'other', section: 'personal', allowed: false },
  { role: Role.TREASURER, target: 'other', section: 'preferences', allowed: false },
  { role: Role.TREASURER, target: 'other', section: 'finance', allowed: true },

  // MEMBER — self-service only.
  { role: Role.MEMBER, target: 'self', section: 'personal', allowed: true },
  { role: Role.MEMBER, target: 'self', section: 'preferences', allowed: true },
  { role: Role.MEMBER, target: 'self', section: 'finance', allowed: false },
  { role: Role.MEMBER, target: 'other', section: 'personal', allowed: false },
  { role: Role.MEMBER, target: 'other', section: 'preferences', allowed: false },
  { role: Role.MEMBER, target: 'other', section: 'finance', allowed: false },
];

describe('§5 D1 — PATCH /api/user/<id> authorisation policy', () => {
  it('covers every (role, target, section) combination exactly once', () => {
    expect(D1).toHaveLength(ALL_ROLES.length * 2 * SECTIONS.length);
  });

  describe.each(D1)('role $role on $target profile, section $section', (row) => {
    const targetId = row.target === 'self' ? ME : SOMEONE_ELSE;

    it(`is ${row.allowed ? 'allowed' : 'denied'}`, () => {
      expect(canWriteSection(actor(row.role), targetId, row.section)).toBe(row.allowed);
    });

    it(`assertSectionWritable ${row.allowed ? 'passes' : 'throws 403'}`, () => {
      const call = (): void => assertSectionWritable(actor(row.role), targetId, row.section);
      if (row.allowed) {
        expect(call).not.toThrow();
      } else {
        expect(call).toThrow(DrfException);
      }
    });

    it(`a plain field write ${row.allowed ? 'passes' : 'throws 403'}`, () => {
      const call = (): void =>
        assertUserPatchAllowed({
          actor: actor(row.role),
          targetUserId: targetId,
          section: row.section,
          fields: ['first_name'],
        });
      if (row.allowed) {
        expect(call).not.toThrow();
      } else {
        expect(call).toThrow(DrfException);
      }
    });
  });

  describe('the `role` field is writable by ADMIN alone', () => {
    it.each(ALL_ROLES)('role %d editing their own `role`', (role) => {
      const call = (): void =>
        assertUserPatchAllowed({
          actor: actor(role),
          targetUserId: ME,
          section: 'personal',
          fields: ['first_name', ROLE_FIELD],
        });
      if (role === Role.ADMIN) {
        expect(call).not.toThrow();
      } else {
        // This is the privilege escalation v1 leaves open
        // (`services/user.py:__update_user_personal` writes `user.role` unconditionally).
        expect(call).toThrow(DrfException);
      }
    });

    it("lets ADMIN set another user's role", () => {
      expect(() =>
        assertUserPatchAllowed({
          actor: actor(Role.ADMIN),
          targetUserId: SOMEONE_ELSE,
          section: 'personal',
          fields: [ROLE_FIELD],
        }),
      ).not.toThrow();
    });

    it('still allows a member to edit the rest of their own personal section', () => {
      expect(() =>
        assertUserPatchAllowed({
          actor: actor(Role.MEMBER),
          targetUserId: ME,
          section: 'personal',
          fields: ['first_name', 'last_name', 'email', 'identification', 'birthdate'],
        }),
      ).not.toThrow();
    });
  });

  describe('denial shape', () => {
    it("is DRF's generic 403, indistinguishable from a role-matrix denial", () => {
      try {
        assertUserPatchAllowed({
          actor: actor(Role.MEMBER),
          targetUserId: ME,
          section: 'finance',
          fields: ['total_quota'],
        });
        throw new Error('expected a 403');
      } catch (error) {
        expect(error).toBeInstanceOf(DrfException);
        const drf = error as DrfException;
        expect(drf.getStatus()).toBe(403);
        expect(drf.drfBody).toEqual({
          detail: 'You do not have permission to perform this action.',
        });
      }
    });

    it('rejects a finance write rather than silently dropping it', () => {
      // Plan §5 D1: "A `finance` write by a non-privileged caller is 403, not a silent no-op."
      const allowlist = userPatchAllowlist({
        actor: actor(Role.MEMBER),
        targetUserId: ME,
        section: 'finance',
        fields: ['total_quota'],
      });
      expect(allowlist.toArray()).toEqual([]);
      expect(allowlist.rejected(['total_quota'])).toEqual(['total_quota']);
    });
  });

  describe('users with no profile row', () => {
    it('are denied every section', () => {
      const orphan: AuthenticatedUser = {
        id: ME,
        username: 'root',
        email: '',
        isActive: true,
        profile: null,
      };
      for (const section of SECTIONS) {
        expect(canWriteSection(orphan, ME, section)).toBe(false);
        expect(() =>
          assertUserPatchAllowed({
            actor: orphan,
            targetUserId: ME,
            section,
            fields: ['first_name'],
          }),
        ).toThrow(DrfException);
      }
    });
  });

  describe('changedFields helper', () => {
    it('reports only keys whose value differs', () => {
      expect(
        changedFields(
          { first_name: 'Foo', role: 3, email: 'a@b.com' },
          { first_name: 'Bar', role: 3, email: 'a@b.com' },
        ),
      ).toEqual(['first_name']);
    });

    it('reports a key missing from the stored row', () => {
      expect(changedFields({ birthdate: '1990-01-01' }, {})).toEqual(['birthdate']);
    });

    it('lets an unchanged `role` key pass the policy when Phase 3 chooses that reading', () => {
      // v1's client posts the whole personal object every time, `role` included.
      const submitted = { first_name: 'New', role: Role.MEMBER };
      const stored = { first_name: 'Old', role: Role.MEMBER };
      expect(() =>
        assertUserPatchAllowed({
          actor: actor(Role.MEMBER),
          targetUserId: ME,
          section: 'personal',
          fields: changedFields(submitted, stored),
        }),
      ).not.toThrow();
    });

    it('still blocks a member who actually changes their own role', () => {
      const submitted = { role: Role.ADMIN };
      const stored = { role: Role.MEMBER };
      expect(() =>
        assertUserPatchAllowed({
          actor: actor(Role.MEMBER),
          targetUserId: ME,
          section: 'personal',
          fields: changedFields(submitted, stored),
        }),
      ).toThrow(DrfException);
    });
  });
});
