import type { Prisma } from '../prisma';
import type { PrismaService } from '../prisma/prisma.service';

/** A client that can read `fondo_api_userprofile`: the service client or a transaction. */
export type UserProfileReader =
  Pick<PrismaService, 'userProfile'> | Pick<Prisma.TransactionClient, 'userProfile'>;

/**
 * `get_users_attr("id", roles)` (`services/user.py`): the ids of the active members.
 *
 * ```python
 * users = UserProfile.objects.filter(is_active=True)            # + role__in=roles
 * return [getattr(user, attr) for user in users]
 * ```
 *
 * Extracted in **Phase 8b** so that two callers share one definition of "the active members":
 *
 *  * `UserService.getUserIds`: the stored `user_ids` a birthday chain gets when it is created,
 *    kept for a v1 rollback;
 *  * `MemberDirectory.activeMemberIdsExcept`: the recipients a birthday greeting actually goes
 *    to, resolved when it is sent (**D49**).
 *
 * If those two definitions drifted, the payload v2 writes and the audience v2 greets would
 * disagree about who a member is. Two cells check that each caller goes through this function:
 * `member-directory.spec.ts › goes through findActiveMemberIds …` and
 * `user.service.spec.ts › getUserIds — … goes through findActiveMemberIds …`.
 *
 * ⚠️ **No `ORDER BY`.** The order is PostgreSQL's heap order, which is part of the stored
 * payload (`"user_ids"=>"[2, 4, 3, 13, …]"` on live rows). Do not sort it.
 */
export async function findActiveMemberIds(
  client: UserProfileReader,
  roles?: readonly number[],
): Promise<number[]> {
  const users = await client.userProfile.findMany({
    where: {
      auth_user: { is_active: true },
      ...(roles === undefined ? {} : { role: { in: [...roles] } }),
    },
    select: { user_ptr_id: true },
  });
  return users.map((user) => user.user_ptr_id);
}
