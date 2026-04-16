import { Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { ConfigService } from '@nestjs/config';
import { EmailTemplate } from '../common/enums';
import { verifyPassword, hashPassword } from './password.util';

export interface UserContext {
  id: number;
  email: string;
  firstName: string;
  lastName: string;
  role: number;
  profileId: number;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly config: ConfigService,
  ) {}

  async login(
    username: string,
    password: string,
  ): Promise<{ token: string } | null> {
    const user = await this.prisma.auth_user.findUnique({
      where: { username },
    });
    if (!user || !user.is_active) return null;

    const valid = await verifyPassword(password, user.password);
    if (!valid) return null;

    const token = randomBytes(20).toString('hex');
    await this.prisma.authtoken_token.upsert({
      where: { user_id: user.id },
      create: { key: token, user_id: user.id, created: new Date() },
      update: { key: token, created: new Date() },
    });

    return { token };
  }

  async validateToken(key: string): Promise<UserContext | null> {
    const record = await this.prisma.authtoken_token.findUnique({
      where: { key },
      include: {
        auth_user: {
          include: { fondo_api_userprofile: true },
        },
      },
    });
    if (!record) return null;

    const user = record.auth_user;
    if (!user.is_active) return null;

    const profile = user.fondo_api_userprofile;
    if (!profile) return null;

    return {
      id: user.id,
      email: user.email,
      firstName: user.first_name,
      lastName: user.last_name,
      role: profile.role,
      profileId: profile.user_ptr_id,
    };
  }

  async requestPasswordReset(email: string): Promise<void> {
    const user = await this.prisma.auth_user.findFirst({
      where: { email, is_active: true },
    });
    if (!user) return;

    const token = randomBytes(25).toString('hex');
    await this.prisma.auth_user.update({
      where: { id: user.id },
      data: { password_reset_token: token },
    });

    const hostUrl = this.config.get<string>('app.hostUrlApp');
    await this.mail.sendMail(EmailTemplate.PASSWORD_RESET, [user.email], {
      user_full_name: `${user.first_name} ${user.last_name}`,
      reset_url: `${hostUrl}/reset/${token}`,
    });
  }

  async confirmPasswordReset(
    token: string,
    newPassword: string,
  ): Promise<boolean> {
    const user = await this.prisma.auth_user.findFirst({
      where: { password_reset_token: token },
    });
    if (!user) return false;

    const hashed = await hashPassword(newPassword);
    await this.prisma.auth_user.update({
      where: { id: user.id },
      data: { password: hashed, password_reset_token: null },
    });

    return true;
  }
}
