import { Injectable, ConflictException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ConfigService } from '@nestjs/config';
import { hashPassword } from '../auth/password.util';
import {
  EmailTemplate,
  Role,
  PowerState,
  SchedulerTaskType,
  SchedulerRepeat,
} from '../common/enums';
import { formatDateEs } from '../common/utils/date-format.util';
import { paginate, unpaginate } from '../common/pagination';

const ITEMS_PER_PAGE = 10;

const ROLE_DISPLAY: Record<number, string> = {
  [Role.ADMIN]: 'ADMIN',
  [Role.PRESIDENT]: 'PRESIDENT',
  [Role.TREASURER]: 'TREASURER',
  [Role.MEMBER]: 'MEMBER',
};

function toDateStr(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function buildUserProfile(profile: {
  user_ptr_id: number;
  role: number;
  birthdate?: Date | null;
  identification: bigint;
  auth_user: {
    first_name: string;
    last_name: string;
    email: string;
  };
}) {
  return {
    full_name: `${profile.auth_user.first_name} ${profile.auth_user.last_name}`,
    identification: Number(profile.identification),
    email: profile.auth_user.email,
    role_display: ROLE_DISPLAY[profile.role] ?? String(profile.role),
    id: profile.user_ptr_id,
    first_name: profile.auth_user.first_name,
    last_name: profile.auth_user.last_name,
    role: profile.role,
    birthdate: profile.birthdate ? toDateStr(profile.birthdate) : null,
  };
}

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService,
  ) {}

  async createUser(body: {
    first_name: string;
    last_name: string;
    email: string;
    identification: number;
    role: number;
  }) {
    const activationKey = randomBytes(25).toString('hex');
    const hostUrl = this.config.get<string>('app.hostUrlApp') ?? '';

    const existingEmail = await this.prisma.auth_user.findFirst({ where: { email: body.email } });
    if (existingEmail) throw new ConflictException('A user with this email already exists');

    const existingId = await this.prisma.fondo_api_userprofile.findFirst({
      where: { identification: BigInt(body.identification) },
    });
    if (existingId) throw new ConflictException('A user with this identification already exists');

    const result = await this.prisma.$transaction(async (tx) => {
      const user = await tx.auth_user.create({
        data: {
          username: body.email,
          email: body.email,
          first_name: body.first_name,
          last_name: body.last_name,
          is_active: false,
          date_joined: new Date(),
          password: '',
        },
      });

      await tx.fondo_api_userprofile.create({
        data: {
          user_ptr_id: user.id,
          identification: BigInt(body.identification),
          role: body.role,
          key_activation: activationKey,
        },
      });

      await tx.fondo_api_userfinance.create({
        data: {
          user_id: user.id,
          contributions: BigInt(0),
          balance_contributions: BigInt(0),
          total_quota: BigInt(0),
          utilized_quota: BigInt(0),
          available_quota: BigInt(0),
          last_modified: new Date(),
        },
      });

      await tx.fondo_api_userpreference.create({
        data: {
          user_id: user.id,
          notifications: false,
          primary_color: '#800000',
          secondary_color: '#c83737',
        },
      });

      return user;
    });

    await this.mail.sendMail(
      EmailTemplate.USER_ACTIVATION,
      [body.email],
      {
        user_full_name: `${body.first_name} ${body.last_name}`,
        activation_url: `${hostUrl}/activate/${result.id}`,
        activation_key: activationKey,
      },
    );

    return result;
  }

  async getUsers(page: number | null) {
    const [profiles, total] = await Promise.all([
      this.prisma.fondo_api_userprofile.findMany({
        include: { auth_user: true },
        orderBy: { user_ptr_id: 'asc' },
        ...(page !== null
          ? { skip: (page - 1) * ITEMS_PER_PAGE, take: ITEMS_PER_PAGE }
          : {}),
      }),
      this.prisma.fondo_api_userprofile.count(),
    ]);

    const items = profiles.map(buildUserProfile);

    if (page !== null) {
      return paginate(items, total, page, ITEMS_PER_PAGE);
    }
    return unpaginate(items);
  }

  async getUser(id: number): Promise<[boolean, object]> {
    const profile = await this.prisma.fondo_api_userprofile.findUnique({
      where: { user_ptr_id: id },
      include: {
        auth_user: true,
        fondo_api_userfinance: true,
        fondo_api_userpreference: true,
        fondo_api_savingaccount: {
          where: { state: 0 },
        },
      },
    });

    if (!profile) return [false, {}];

    const finance = profile.fondo_api_userfinance[0];
    const pref = profile.fondo_api_userpreference[0];

    const totalSavings = (profile.fondo_api_savingaccount ?? []).reduce(
      (sum, sa) => sum + Number(sa.value),
      0,
    );

    return [
      true,
      {
        user: buildUserProfile(profile),
        finance: finance
          ? {
              contributions: Number(finance.contributions),
              balance_contributions: Number(finance.balance_contributions),
              total_quota: Number(finance.total_quota),
              available_quota: Number(finance.available_quota),
              last_modified: formatDateEs(finance.last_modified),
              utilized_quota: Number(finance.utilized_quota),
              total_savingaccounts: totalSavings,
            }
          : null,
        preferences: pref
          ? {
              notifications: pref.notifications,
              primary_color: pref.primary_color,
              secondary_color: pref.secondary_color,
            }
          : null,
      },
    ];
  }

  async inactiveUser(id: number): Promise<void> {
    await this.prisma.auth_user.update({
      where: { id },
      data: { is_active: false },
    });
  }

  async updateUser(
    id: number,
    body: {
      type: string;
      preferences: {
        notifications?: boolean;
        primary_color?: string;
        secondary_color?: string;
      },
      personal: {
        first_name?: string;
        last_name?: string;
        email?: string;
        birthdate?: string;
        role?: number;
        identification?: number;
      },
      finance: {
        contributions?: number;
        balance_contributions?: number;
        total_quota?: number;
        utilized_quota?: number;
      }
    },
  ): Promise<void> {
    if (body.type === 'personal') {
      const { personal } = body;
      if (personal.first_name !== undefined || personal.last_name !== undefined || personal.email !== undefined) {
        const data: Record<string, unknown> = {};
        if (personal.first_name !== undefined) data.first_name = personal.first_name;
        if (personal.last_name !== undefined) data.last_name = personal.last_name;
        if (personal.email !== undefined) {
          data.email = personal.email;
          data.username = personal.email;
        }
        await this.prisma.auth_user.update({ where: { id }, data });
      }

      const profileData: Record<string, unknown> = {};
      if (personal.role !== undefined) profileData.role = personal.role;
      if (personal.identification !== undefined) profileData.identification = BigInt(personal.identification);
      if (personal.birthdate !== undefined) profileData.birthdate = new Date(personal.birthdate);

      if (Object.keys(profileData).length > 0) {
        await this.prisma.fondo_api_userprofile.update({
          where: { user_ptr_id: id },
          data: profileData,
        });
      }

      if (personal.birthdate !== undefined) {
        const profile = await this.prisma.fondo_api_userprofile.findUnique({
          where: { user_ptr_id: id },
          include: { auth_user: true },
        });
        if (profile) {
          await this.createBirthdateNotification({
            id: profile.user_ptr_id,
            full_name: `${profile.auth_user.first_name} ${profile.auth_user.last_name}`,
            birthdate: personal.birthdate,
          });
        }
      }
    } else if (body.type === 'finance') {
      const { finance } = body;
      const totalQuota = finance.total_quota ?? 0;
      const utilizedQuota = finance.utilized_quota ?? 0;
      const available = totalQuota - utilizedQuota;
      const financeRecord = await this.prisma.fondo_api_userfinance.findFirst({
        where: { user_id: id },
      });
      if (financeRecord) {
        await this.prisma.fondo_api_userfinance.update({
          where: { id: financeRecord.id },
          data: {
            contributions: finance.contributions !== undefined ? BigInt(finance.contributions) : undefined,
            balance_contributions: finance.balance_contributions !== undefined ? BigInt(finance.balance_contributions) : undefined,
            total_quota: finance.total_quota !== undefined ? BigInt(finance.total_quota) : undefined,
            utilized_quota: finance.utilized_quota !== undefined ? BigInt(finance.utilized_quota) : undefined,
            available_quota: BigInt(available),
            last_modified: new Date(),
          },
        });
      }
    } else if (body.type === 'preferences') {
      const { preferences } = body;
      const prefRecord = await this.prisma.fondo_api_userpreference.findFirst({
        where: { user_id: id },
      });
      if (prefRecord) {
        await this.prisma.fondo_api_userpreference.update({
          where: { id: prefRecord.id },
          data: {
            notifications: preferences.notifications,
            primary_color: preferences.primary_color,
            secondary_color: preferences.secondary_color,
          },
        });
      }
      if (preferences.notifications === false) {
        await this.notifications.removeAllSubscriptions(id);
      }
    }
  }

  async activateUser(
    id: number,
    body: { key: string; identification: number; password: string },
  ): Promise<boolean> {
    const profile = await this.prisma.fondo_api_userprofile.findFirst({
      where: {
        user_ptr_id: id,
        key_activation: body.key,
        identification: BigInt(body.identification),
      },
    });
    if (!profile) return false;

    const hashed = await hashPassword(body.password);
    await this.prisma.auth_user.update({
      where: { id },
      data: { password: hashed, is_active: true },
    });
    await this.prisma.fondo_api_userprofile.update({
      where: { user_ptr_id: id },
      data: { key_activation: null },
    });

    return true;
  }

  async bulkUpdateUsers(fileBuffer: Buffer): Promise<void> {
    const content = fileBuffer.toString('utf-8');
    const lines = content.split('\n').filter((l) => l.trim());

    for (const line of lines) {
      const [identStr, balStr, totalStr, contribStr, utilizedStr] = line.split('\t');
      const identification = BigInt(identStr.trim());

      const profile = await this.prisma.fondo_api_userprofile.findUnique({
        where: { identification },
      });
      if (!profile) continue;

      const financeRecord = await this.prisma.fondo_api_userfinance.findFirst({
        where: { user_id: profile.user_ptr_id },
      });
      if (!financeRecord) continue;

      const totalQuota = BigInt(totalStr.trim());
      const utilizedQuota = BigInt(utilizedStr.trim());

      await this.prisma.fondo_api_userfinance.update({
        where: { id: financeRecord.id },
        data: {
          balance_contributions: BigInt(balStr.trim()),
          total_quota: totalQuota,
          contributions: BigInt(contribStr.trim()),
          utilized_quota: utilizedQuota,
          available_quota: totalQuota - utilizedQuota,
          last_modified: new Date(),
        },
      });
    }
  }

  async getUsersAttr(attr: 'id' | 'email', roles?: number[]): Promise<(number | string)[]> {
    const profiles = await this.prisma.fondo_api_userprofile.findMany({
      where: {
        auth_user: { is_active: true },
        ...(roles ? { role: { in: roles } } : {}),
      },
      include: { auth_user: true },
    });

    if (attr === 'id') {
      return profiles.map((p) => p.user_ptr_id);
    }
    return profiles.map((p) => p.auth_user.email);
  }

  async getProfile(userId: number) {
    return this.prisma.fondo_api_userprofile.findUnique({
      where: { user_ptr_id: userId },
      include: { auth_user: true },
    });
  }

  async getUsersBirthdate(): Promise<{ birthdate: string; full_name: string }[]> {
    const profiles = await this.prisma.fondo_api_userprofile.findMany({
      where: {
        auth_user: { is_active: true },
        birthdate: { not: null },
      },
      include: { auth_user: true },
    });

    return profiles
      .filter((p) => p.birthdate)
      .map((p) => ({
        birthdate: toDateStr(p.birthdate!),
        full_name: `${p.auth_user.first_name} ${p.auth_user.last_name}`,
      }));
  }

  async handlePowerRequest(
    userId: number,
    request: {
      type: string;
      requestee_id?: number;
      meeting_date?: string;
      id?: number;
      state?: number;
      page?: number;
    },
  ) {
    if (request.type === 'post') {
      const power = await this.prisma.fondo_api_power.create({
        data: {
          requestee_id: request.requestee_id!,
          requester_id: userId,
          meeting_date: new Date(request.meeting_date!),
          state: PowerState.PENDING,
        },
      });

      const requesteeIds = await this.getUsersAttr('id', undefined);
      const requesteeProfile = await this.getProfile(request.requestee_id!);
      if (requesteeProfile) {
        await this.notifications.sendNotification(
          [request.requestee_id!],
          {
            body: `Tienes una nueva solicitud de poder del usuario ${userId}`,
            target: '/power',
          },
        );
      }

      return power;
    } else if (request.type === 'get') {
      const page = request.page ?? 1;
      const powers = await this.prisma.fondo_api_power.findMany({
        where: {
          OR: [{ requestee_id: userId }, { requester_id: userId }],
        },
        include: {
          fondo_api_userprofile_fondo_api_power_requestee_idTofondo_api_userprofile: {
            include: { auth_user: true },
          },
          fondo_api_userprofile_fondo_api_power_requester_idTofondo_api_userprofile: {
            include: { auth_user: true },
          },
        },
        orderBy: { id: 'desc' },
        skip: (page - 1) * ITEMS_PER_PAGE,
        take: ITEMS_PER_PAGE,
      });

      const total = await this.prisma.fondo_api_power.count({
        where: {
          OR: [{ requestee_id: userId }, { requester_id: userId }],
        },
      });

      const list = powers.map((p) => {
        const requestee = p.fondo_api_userprofile_fondo_api_power_requestee_idTofondo_api_userprofile;
        const requester = p.fondo_api_userprofile_fondo_api_power_requester_idTofondo_api_userprofile;
        return {
          id: p.id,
          state: p.state,
          meeting_date: toDateStr(p.meeting_date),
          requestee: `${requestee.auth_user.first_name} ${requestee.auth_user.last_name}`,
          requester: `${requester.auth_user.first_name} ${requester.auth_user.last_name}`,
        };
      });

      return paginate(list, total, page, ITEMS_PER_PAGE);
    } else if (request.type === 'patch') {
      const power = await this.prisma.fondo_api_power.update({
        where: { id: request.id! },
        data: { state: request.state },
      });

      if (request.state === PowerState.APPROVED) {
        const emails = (await this.getUsersAttr('email')) as string[];
        const meetingDateStr = formatDateEs(power.meeting_date);
        await this.mail.sendMail(
          EmailTemplate.POWER_APPROVED,
          emails,
          { meeting_date: meetingDateStr },
        );
      }

      return power;
    }
  }

  async createBirthdateNotification(user: {
    id: number;
    full_name: string;
    birthdate: string;
  }): Promise<void> {
    await this.notifications.removeScheduledNotifications(
      user.id,
      SchedulerTaskType.NOTIFICATIONS,
    );

    const today = new Date();
    const [, monthStr, dayStr] = user.birthdate.split('-');
    const month = parseInt(monthStr, 10) - 1;
    const day = parseInt(dayStr, 10);
    const runDate = new Date(today.getFullYear(), month, day);

    await this.notifications.scheduleNotification(
      user.id,
      {
        body: `Feliz cumpleaños ${user.full_name}!`,
        target: '/',
      },
      runDate,
      SchedulerTaskType.NOTIFICATIONS,
      SchedulerRepeat.YEARLY,
    );
  }
}
