// Tầng API (EN-03 bước 3): GET /api/notifications/sync cho người nhận đồng bộ thông báo sau khi mất kết nối socket.
// Biết ai gọi qua JwtAuthGuard toàn cục; chỉ role người nhận (MEMBER) được gọi; luật nằm ở NotificationsService.
import { Controller, Get, Query } from '@nestjs/common';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import { AuthPrincipal } from '../auth/auth.types';
import { SyncQueryDto } from './notifications.dto';
import { NotificationsService, RECIPIENT_ROLE } from './notifications.service';

@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  // EN-03-TC07, EN-03-TC11: chỉ trả thông báo của chính người đăng nhập; không token thì 401 (Guard), query sai thì 400.
  @Get('sync')
  @Roles(RECIPIENT_ROLE)
  sync(@CurrentUser() user: AuthPrincipal, @Query() query: SyncQueryDto) {
    return this.notifications.sync(user.id, query.cursor, query.limit);
  }
}
