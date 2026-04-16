import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { UsersService } from '../users/users.service';
import { formatDateEs } from '../common/utils/date-format.util';
import { paginate, unpaginate } from '../common/pagination';

const ITEMS_PER_PAGE = 10;

function buildSavingAccount(account: {
  id: number;
  value: bigint;
  created_at: Date;
  state: number;
  end_date: Date;
  user_id: number;
  fondo_api_userprofile?: {
    auth_user: { first_name: string; last_name: string };
  };
}) {
  return {
    value: Number(account.value),
    created_at: formatDateEs(account.created_at),
    state: account.state,
    user_full_name: account.fondo_api_userprofile
      ? `${account.fondo_api_userprofile.auth_user.first_name} ${account.fondo_api_userprofile.auth_user.last_name}`
      : '',
    id: account.id,
    end_date: formatDateEs(account.end_date),
  };
}

@Injectable()
export class SavingAccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly users: UsersService,
  ) {}

  async createAccount(userId: number, body: { end_date: string }) {
    const account = await this.prisma.fondo_api_savingaccount.create({
      data: {
        user_id: userId,
        end_date: new Date(body.end_date),
        state: 0, // ACTIVE
        value: BigInt(0),
        created_at: new Date(),
      },
      include: {
        fondo_api_userprofile: { include: { auth_user: true } },
      },
    });

    const adminTreasurerIds = (await this.users.getUsersAttr('id', [0, 2])) as number[];
    await this.notifications.sendNotification(adminTreasurerIds, {
      body: `Nueva cuenta de ahorro #${account.id}`,
      target: `/saving-account/${account.id}`,
    });

    return buildSavingAccount(account);
  }

  async getAccounts(
    userId: number,
    page: number | null,
    allAccounts: boolean,
    state: number | null,
    shouldPaginate: boolean,
  ) {
    const where: Record<string, unknown> = {};
    if (!allAccounts) where.user_id = userId;
    if (state !== null) where.state = state;

    const [accounts, total] = await Promise.all([
      this.prisma.fondo_api_savingaccount.findMany({
        where,
        include: { fondo_api_userprofile: { include: { auth_user: true } } },
        orderBy: { id: 'desc' },
        ...(shouldPaginate && page !== null
          ? { skip: (page - 1) * ITEMS_PER_PAGE, take: ITEMS_PER_PAGE }
          : {}),
      }),
      this.prisma.fondo_api_savingaccount.count({ where }),
    ]);

    const items = accounts.map(buildSavingAccount);

    if (shouldPaginate && page !== null) {
      return paginate(items, total, page, ITEMS_PER_PAGE);
    }
    return unpaginate(items);
  }

  async updateAccount(body: { id: number; state: number; value: number }) {
    const account = await this.prisma.fondo_api_savingaccount.update({
      where: { id: body.id },
      data: {
        state: body.state,
        value: BigInt(body.value),
      },
      include: {
        fondo_api_userprofile: { include: { auth_user: true } },
      },
    });

    if (!account) throw new NotFoundException('Saving account not found');
    return buildSavingAccount(account);
  }
}
