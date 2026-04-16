import {
  Controller,
  Post,
  Param,
  Body,
  Req,
  HttpCode,
  HttpStatus,
  MethodNotAllowedException,
} from '@nestjs/common';
import { MaxRole } from '../auth/roles.decorator';
import { NotificationsService } from './notifications.service';
import { Role } from '../common/enums';
import { UserContext } from '../auth/auth.service';

interface SubscribeBody {
  endpoint: string;
  keys?: Record<string, string>;
  [key: string]: unknown;
}

interface UnsubscribeBody {
  endpoint: string;
}

@Controller('api/notification')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Post(':operation')
  @MaxRole(Role.MEMBER)
  @HttpCode(HttpStatus.OK)
  async handleNotification(
    @Param('operation') operation: string,
    @Body() body: SubscribeBody & UnsubscribeBody,
    @Req() req: { user: UserContext },
  ): Promise<void> {
    const userId = req.user.profileId;

    if (operation === 'subscribe') {
      await this.notifications.saveSubscription(userId, body);
    } else if (operation === 'unsubscribe') {
      await this.notifications.unregisterSubscription(userId, body.endpoint);
    } else {
      throw new MethodNotAllowedException();
    }
  }
}
