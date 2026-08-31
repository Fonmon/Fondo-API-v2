import { DrfException } from '../../common/http/drf.exception';
import { ALL_ROLES, Role } from '../permissions/roles';
import type { AuthenticatedUser } from '../types/authenticated-user';
import {
  FINANCE_FIELDS,
  ROLE_FIELD,
  resolveSection,
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

/** An ordinary, non-privileged field of each section (`services/user.py:208-261`). */
const PLAIN_FIELD: Readonly<Record<UserSection, string>> = {
  personal: 'first_name',
  finance: 'contributions',
  preferences: 'primary_color',
};

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
          fields: [PLAIN_FIELD[row.section]],
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
            fields: [PLAIN_FIELD[section]],
          }),
        ).toThrow(DrfException);
      }
    });
  });

  /**
   * Review finding S4: the allowlist must come from the *schema*, not from the payload.
   * Before this, `userPatchAllowlist` returned `FieldAllowlist.from(attempt.fields)`, so
   * anything a caller invented was accepted.
   */
  describe('the allowlist is positive — built from services/user.py, not from the payload', () => {
    it('is exactly the section field set for a caller with full rights', () => {
      expect(
        userPatchAllowlist({
          actor: actor(Role.ADMIN),
          targetUserId: SOMEONE_ELSE,
          section: 'personal',
          fields: [],
        }).toArray(),
      ).toEqual(['birthdate', 'email', 'first_name', 'identification', 'last_name', 'role']);

      expect(
        userPatchAllowlist({
          actor: actor(Role.TREASURER),
          targetUserId: SOMEONE_ELSE,
          section: 'finance',
          fields: [],
        }).toArray(),
      ).toEqual(['balance_contributions', 'contributions', 'total_quota', 'utilized_quota']);

      expect(
        userPatchAllowlist({
          actor: actor(Role.MEMBER),
          targetUserId: ME,
          section: 'preferences',
          fields: [],
        }).toArray(),
      ).toEqual(['notifications', 'primary_color', 'secondary_color']);
    });

    it('drops `role` for everyone but ADMIN, keeping the rest of `personal`', () => {
      expect(
        userPatchAllowlist({
          actor: actor(Role.MEMBER),
          targetUserId: ME,
          section: 'personal',
          fields: [],
        }).toArray(),
      ).toEqual(['birthdate', 'email', 'first_name', 'identification', 'last_name']);
    });

    it.each([
      ['is_active'],
      ['key_activation'],
      ['user_ptr_id'],
      ['username'],
      ['available_quota'],
      ['whatever'],
    ])(
      'rejects the unexpected field %s on a member editing their own personal section',
      (field) => {
        // Every one of these was *accepted* before S4 was fixed, because the allowlist was
        // built from the caller's own key set. `username` is absent on purpose — D15.
        expect(() =>
          assertUserPatchAllowed({
            actor: actor(Role.MEMBER),
            targetUserId: ME,
            section: 'personal',
            fields: ['first_name', field],
          }),
        ).toThrow(DrfException);
      },
    );

    it('rejects a personal field submitted against the finance section', () => {
      // Sections do not leak into each other: `update_user` applies exactly one.
      expect(() =>
        assertUserPatchAllowed({
          actor: actor(Role.ADMIN),
          targetUserId: SOMEONE_ELSE,
          section: 'finance',
          fields: ['first_name'],
        }),
      ).toThrow(DrfException);
    });

    it('rejects `available_quota`, which v1 derives rather than reads', () => {
      // `available_quota = total_quota - utilized_quota` (`services/user.py:259`).
      expect(FINANCE_FIELDS.has('available_quota')).toBe(false);
      expect(() =>
        assertUserPatchAllowed({
          actor: actor(Role.TREASURER),
          targetUserId: SOMEONE_ELSE,
          section: 'finance',
          fields: ['available_quota'],
        }),
      ).toThrow(DrfException);
    });

    describe('D16 / Q26 — identification as a privileged field', () => {
      const ADMIN_ONLY_IDENTIFICATION = {
        [ROLE_FIELD]: [Role.ADMIN],
        identification: [Role.ADMIN],
      };

      it('is writable by a member today, because Q26 is still open', () => {
        expect(
          userPatchAllowlist({
            actor: actor(Role.MEMBER),
            targetUserId: ME,
            section: 'personal',
            fields: [],
          }).permits('identification'),
        ).toBe(true);
      });

      it('becomes ADMIN-only by passing the D16 map, with no code change', () => {
        expect(
          userPatchAllowlist(
            { actor: actor(Role.MEMBER), targetUserId: ME, section: 'personal', fields: [] },
            ADMIN_ONLY_IDENTIFICATION,
          ).permits('identification'),
        ).toBe(false);

        expect(
          userPatchAllowlist(
            {
              actor: actor(Role.ADMIN),
              targetUserId: SOMEONE_ELSE,
              section: 'personal',
              fields: [],
            },
            ADMIN_ONLY_IDENTIFICATION,
          ).permits('identification'),
        ).toBe(true);
      });
    });
  });

  /**
   * §7 "C8 resolved" — the two rules operate at different levels and are applied in order.
   */
  describe('C8 — body.type gates the section, changedFields gates the field', () => {
    describe('rule 1: the section gate ignores the field set entirely', () => {
      it.each([[[]], [['contributions']], [['contributions', 'total_quota']]])(
        'a MEMBER declaring type=finance is 403 with fields %j',
        (fields) => {
          // "A `finance` write by a non-privileged caller is 403, not a silent no-op"
          // (§5 D1) — including the empty change-set, which is the *common* case, because
          // v1's client posts an unchanged `finance` block on every profile save.
          expect(() =>
            assertUserPatchAllowed({
              actor: actor(Role.MEMBER),
              targetUserId: ME,
              section: 'finance',
              fields,
            }),
          ).toThrow(DrfException);
        },
      );

      it('403s a PRESIDENT declaring type=finance on their own row', () => {
        expect(() =>
          assertUserPatchAllowed({
            actor: actor(Role.PRESIDENT),
            targetUserId: ME,
            section: 'finance',
            fields: [],
          }),
        ).toThrow(DrfException);
      });

      it('lets a TREASURER declare an unchanged finance write', () => {
        expect(() =>
          assertUserPatchAllowed({
            actor: actor(Role.TREASURER),
            targetUserId: SOMEONE_ELSE,
            section: 'finance',
            fields: [],
          }),
        ).not.toThrow();
      });

      it('lets a MEMBER save their own personal section with nothing changed', () => {
        expect(() =>
          assertUserPatchAllowed({
            actor: actor(Role.MEMBER),
            targetUserId: ME,
            section: 'personal',
            fields: [],
          }),
        ).not.toThrow();
      });
    });

    describe('rule 2: an undeclared section is ignored, never a 403', () => {
      it('resolves the section from `type`, exactly as update_user dispatches', () => {
        expect(resolveSection('personal')).toBe('personal');
        expect(resolveSection('finance')).toBe('finance');
        // v1's fall-through: anything else lands on preferences.
        expect(resolveSection('preferences')).toBe('preferences');
        expect(resolveSection('nonsense')).toBe('preferences');
        expect(resolveSection(undefined)).toBe('preferences');
        expect(resolveSection(null)).toBe('preferences');
        expect(resolveSection(42)).toBe('preferences');
      });

      it("ignores a finance block in a member's ordinary personal save", () => {
        // The v1 body shape: `{type: 'personal', personal: {...}, finance: {...}}`
        // (test_user_views.py:49-113). Authorising on the presence of `finance` would 403
        // 14 of 15 members on day one.
        const body = {
          type: 'personal',
          personal: { first_name: 'Ana', role: Role.MEMBER },
          finance: { total_quota: 999_999 },
        };
        const section = resolveSection(body.type);
        expect(section).toBe('personal');

        expect(() =>
          assertUserPatchAllowed({
            actor: actor(Role.MEMBER),
            targetUserId: ME,
            section,
            fields: changedFields(body.personal, { first_name: 'Old', role: Role.MEMBER }),
          }),
        ).not.toThrow();
      });
    });

    describe('rule 3: privileged fields inside the dispatched section', () => {
      it('403s only on a real change of `role`', () => {
        const stored = { first_name: 'Old', role: Role.MEMBER };
        const echoed = { first_name: 'New', role: Role.MEMBER };
        const escalating = { first_name: 'New', role: Role.ADMIN };

        expect(() =>
          assertUserPatchAllowed({
            actor: actor(Role.MEMBER),
            targetUserId: ME,
            section: 'personal',
            fields: changedFields(echoed, stored),
          }),
        ).not.toThrow();

        expect(() =>
          assertUserPatchAllowed({
            actor: actor(Role.MEMBER),
            targetUserId: ME,
            section: 'personal',
            fields: changedFields(escalating, stored),
          }),
        ).toThrow(DrfException);
      });
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

    /** Reviewer §4.1 — the two sides come from different places and must be normalised. */
    describe('normalises across the JSON body / Prisma row boundary', () => {
      it('treats a bigint column and the number in the body as equal', () => {
        expect(
          changedFields({ identification: 1098765432 }, { identification: 1098765432n }),
        ).toEqual([]);
        expect(
          changedFields({ identification: 1098765433 }, { identification: 1098765432n }),
        ).toEqual(['identification']);
      });

      it('treats a @db.Date row and the ISO string in the body as equal', () => {
        const stored = { birthdate: new Date('1990-05-03T00:00:00.000Z') };
        expect(changedFields({ birthdate: '1990-05-03' }, stored)).toEqual([]);
        expect(changedFields({ birthdate: '1990-05-04' }, stored)).toEqual(['birthdate']);
      });

      it('treats a numeric string and a number as equal (form-encoded clients)', () => {
        expect(changedFields({ role: '3' }, { role: 3 })).toEqual([]);
        expect(changedFields({ role: '0' }, { role: 3 })).toEqual(['role']);
      });

      it('treats null and undefined as the same absence', () => {
        expect(changedFields({ birthdate: null }, {})).toEqual([]);
        expect(changedFields({ birthdate: null }, { birthdate: '1990-05-03' })).toEqual([
          'birthdate',
        ]);
        expect(changedFields({ birthdate: '1990-05-03' }, { birthdate: null })).toEqual([
          'birthdate',
        ]);
      });

      it('does not 403 a member whose client echoes a bigint identification as a number', () => {
        // Without normalisation this is a phantom change on every single save, and under
        // D16 it would become a 403 the moment Q26 is answered.
        expect(() =>
          assertUserPatchAllowed({
            actor: actor(Role.MEMBER),
            targetUserId: ME,
            section: 'personal',
            fields: changedFields(
              { first_name: 'Ana', identification: 99999, role: Role.MEMBER },
              { first_name: 'Ana', identification: 99999n, role: Role.MEMBER },
            ),
          }),
        ).not.toThrow();
      });
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
