// Tầng API (EN-03 bước 3): GET /api/notifications/sync cho người nhận đồng bộ thông báo sau khi mất kết nối socket.
// US-48: bốn vai trò dùng sync; chỉ trả notification có recipient của principal. Inbox riêng vẫn chỉ MEMBER.
import { Controller, Get, Query } from '@nestjs/common';
import { ApiOkResponse } from '@nestjs/swagger';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import { AuthPrincipal } from '../auth/auth.types';
import { NotificationSyncDto, SyncQueryDto } from './notifications.dto';
import { NotificationsService, RECIPIENT_ROLES } from './notifications.service';

@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  // EN-03-TC07, EN-03-TC11: chỉ trả thông báo của chính người đăng nhập; không token thì 401 (Guard), query sai thì 400.
  @Get('sync')
  @ApiOkResponse({ type: NotificationSyncDto })
  @Roles(...RECIPIENT_ROLES)
  sync(@CurrentUser() user: AuthPrincipal, @Query() query: SyncQueryDto) {
    return this.notifications.sync(user.id, query.cursor, query.limit);
  }
}
