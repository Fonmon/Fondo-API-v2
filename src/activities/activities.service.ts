import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

function toDateStr(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

const ROLE_DISPLAY: Record<number, string> = {
  0: 'ADMIN',
  1: 'PRESIDENT',
  2: 'TREASURER',
  3: 'MEMBER',
};

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
export class ActivitiesService {
  constructor(private readonly prisma: PrismaService) {}

  async createYear(): Promise<{ id: number; year: number; enable: boolean } | false> {
    const currentYear = new Date().getFullYear();

    const existing = await this.prisma.fondo_api_activityyear.findUnique({
      where: { year: BigInt(currentYear) },
    });
    if (existing) return false;

    // Disable all previous years
    await this.prisma.fondo_api_activityyear.updateMany({
      data: { enable: false },
    });

    const newYear = await this.prisma.fondo_api_activityyear.create({
      data: {
        year: BigInt(currentYear),
        enable: true,
      },
    });

    return {
      id: newYear.id,
      year: Number(newYear.year),
      enable: newYear.enable,
    };
  }

  async getYears(): Promise<{ id: number; year: number; enable: boolean }[]> {
    const years = await this.prisma.fondo_api_activityyear.findMany({
      orderBy: { year: 'desc' },
    });
    return years.map((y) => ({
      id: y.id,
      year: Number(y.year),
      enable: y.enable,
    }));
  }

  async getActivities(yearId: number): Promise<{ id: number; name: string }[]> {
    const activities = await this.prisma.fondo_api_activity.findMany({
      where: { year_id: yearId },
      orderBy: { date: 'desc' },
    });
    return activities.map((a) => ({
      id: a.id,
      name: a.name,
    }));
  }

  async createActivity(
    data: { name: string; date: string; value: number },
    yearId: number,
  ) {
    const activity = await this.prisma.fondo_api_activity.create({
      data: {
        name: data.name,
        date: new Date(data.date),
        value: BigInt(data.value),
        year_id: yearId,
      },
    });

    // Create ActivityUser for ALL active users
    const profiles = await this.prisma.fondo_api_userprofile.findMany({
      where: { auth_user: { is_active: true } },
    });

    for (const profile of profiles) {
      await this.prisma.fondo_api_activityuser.create({
        data: {
          activity_id: activity.id,
          user_id: profile.user_ptr_id,
          state: 0, // NOT_PAID
        },
      });
    }

    return {
      id: activity.id,
      name: activity.name,
      date: toDateStr(activity.date),
      value: Number(activity.value),
    };
  }

  async getActivity(id: number) {
    const activity = await this.prisma.fondo_api_activity.findUnique({
      where: { id },
      include: {
        fondo_api_activityuser: {
          include: {
            fondo_api_userprofile: { include: { auth_user: true } },
          },
          orderBy: { user_id: 'asc' },
        },
      },
    });

    if (!activity) return null;

    return {
      id: activity.id,
      name: activity.name,
      date: toDateStr(activity.date),
      value: Number(activity.value),
      users: activity.fondo_api_activityuser.map((au) => ({
        id: au.id,
        state: au.state,
        user: buildUserProfile(au.fondo_api_userprofile),
      })),
    };
  }

  async removeActivity(id: number): Promise<void> {
    await this.prisma.fondo_api_activityuser.deleteMany({
      where: { activity_id: id },
    });
    await this.prisma.fondo_api_activity.delete({
      where: { id },
    });
  }

  async patchActivity(
    patch: string,
    id: number,
    data: { name?: string; date?: string; value?: number; id?: number; state?: number },
  ) {
    if (patch === 'activity') {
      const updateData: Record<string, unknown> = {};
      if (data.name !== undefined) updateData.name = data.name;
      if (data.date !== undefined) updateData.date = new Date(data.date);
      if (data.value !== undefined) updateData.value = BigInt(data.value);

      await this.prisma.fondo_api_activity.update({
        where: { id },
        data: updateData,
      });
    } else if (patch === 'user') {
      await this.prisma.fondo_api_activityuser.update({
        where: { id: data.id! },
        data: { state: data.state },
      });
    }

    return this.getActivity(id);
  }
}
