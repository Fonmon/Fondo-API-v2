import type { PrismaService } from '../prisma/prisma.service';
import * as activeMembers from '../users/active-members.query';
import { MemberDirectory } from './member-directory';

/**
 * **Phase 8b.** The two membership reads behind D39 and D49, with the ORM mocked. The same reads
 * against a real `auth_user` table are in `test/scheduler-runner.e2e-spec.ts`,
 * *Phase 8b — a birthday task at send time*.
 */
describe('MemberDirectory', () => {
  let prisma: { authUser: { findUnique: jest.Mock }; userProfile: { findMany: jest.Mock } };
  let directory: MemberDirectory;

  beforeEach(() => {
    prisma = {
      authUser: { findUnique: jest.fn() },
      userProfile: { findMany: jest.fn().mockResolvedValue([]) },
    };
    directory = new MemberDirectory(prisma as unknown as PrismaService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('ownerStatus — D39', () => {
    it.each([
      [{ is_active: true }, 'active'],
      [{ is_active: false }, 'inactive'],
      [null, 'missing'],
    ] as const)('maps the auth_user row %j to %s', async (row, status) => {
      prisma.authUser.findUnique.mockResolvedValue(row);

      await expect(directory.ownerStatus(15)).resolves.toBe(status);
      // Behaviour, not query shape: the row looked up is the owner's, and `is_active` is read.
      // Blind control B3 (a wider `select`) killed an exact-object pin here in the first mutation
      // run; `docs/phase-8b-deviations.md` §5.3.
      expect(prisma.authUser.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 15 },
          select: expect.objectContaining({ is_active: true }) as unknown,
        }),
      );
    });
  });

  describe('activeMemberIdsExcept — D49', () => {
    it('is the active-member query minus the owner, in the order the query returned', async () => {
      prisma.userProfile.findMany.mockResolvedValue([
        { user_ptr_id: 2 },
        { user_ptr_id: 5 },
        { user_ptr_id: 14 },
        { user_ptr_id: 3 },
      ]);

      await expect(directory.activeMemberIdsExcept(5)).resolves.toEqual([2, 14, 3]);
    });

    it('filters on auth_user.is_active, with no role filter and no ORDER BY', async () => {
      await directory.activeMemberIdsExcept(5);

      expect(prisma.userProfile.findMany).toHaveBeenCalledWith({
        where: { auth_user: { is_active: true } },
        select: { user_ptr_id: true },
      });
    });

    it('returns the list unchanged when the owner is not in it (an inactive owner)', async () => {
      prisma.userProfile.findMany.mockResolvedValue([{ user_ptr_id: 2 }, { user_ptr_id: 3 }]);

      await expect(directory.activeMemberIdsExcept(15)).resolves.toEqual([2, 3]);
    });

    /**
     * The definition of "active member" is shared with `UserService.getUserIds`, which writes
     * the stored `user_ids` at chain creation. `user.service.spec.ts` has the matching cell for
     * that caller.
     */
    it('goes through findActiveMemberIds, the query UserService.getUserIds also uses', async () => {
      const shared = jest.spyOn(activeMembers, 'findActiveMemberIds').mockResolvedValue([9]);

      await expect(directory.activeMemberIdsExcept(5)).resolves.toEqual([9]);
      expect(shared).toHaveBeenCalledWith(prisma);
    });
  });
});
