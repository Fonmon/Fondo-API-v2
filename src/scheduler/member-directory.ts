import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { findActiveMemberIds } from '../users/active-members.query';

/** What the scheduler knows about a birthday task's `owner_id` when it runs. */
export type OwnerStatus = 'active' | 'inactive' | 'missing';

/**
 * **Phase 8b.** The two membership reads a birthday greeting needs when it is sent.
 *
 * v1's executer reads no member data at all: it `json.loads` the recipient list frozen into the
 * payload when the chain was created, and sends. Two operator decisions change that for
 * `type = 'birthdate'` only:
 *
 *  * **D39 (Q35, Q48)**: a departed member's birthday is not announced. {@link ownerStatus}
 *    answers "departed" from `auth_user.is_active`, which is the column v2's soft delete writes.
 *  * **D49 (Q49)**: the greeting goes to the members who are active *now*.
 *    {@link activeMemberIdsExcept} is `get_users_attr("id")` minus the owner, resolved at send
 *    time.
 *
 * A provider in the scheduler rather than a dependency on `UserService`: importing `UserModule`
 * would pull the mail and auth stacks into the runner's module graph for one `findMany`. The
 * active-member query itself is shared, through {@link findActiveMemberIds}, so there is still
 * only one definition of "active member".
 */
@Injectable()
export class MemberDirectory {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * `auth_user.is_active` for the owner, or `'missing'` when no `auth_user` row has that id.
   *
   * `auth_user` rather than `fondo_api_userprofile`: `is_active` lives there, and a member is the
   * `auth_user` row (Django MTI). A profile-less `auth_user` still has an activity flag.
   */
  async ownerStatus(ownerId: number): Promise<OwnerStatus> {
    const user = await this.prisma.authUser.findUnique({
      where: { id: ownerId },
      select: { is_active: true },
    });
    if (user === null) {
      return 'missing';
    }
    return user.is_active ? 'active' : 'inactive';
  }

  /**
   * Every active member except `ownerId`, in heap order.
   *
   * `filter` rather than v1's remove-first-occurrence: the ids come from a primary key, so they
   * are unique and the two are the same list. The owner is dropped whether or not they are
   * active. D20's guard at creation handles the same case with `indexOf`.
   */
  async activeMemberIdsExcept(ownerId: number): Promise<number[]> {
    const ids = await findActiveMemberIds(this.prisma);
    return ids.filter((id) => id !== ownerId);
  }
}
