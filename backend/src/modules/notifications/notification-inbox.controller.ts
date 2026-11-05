// Tầng API (US-47 bước 2): 4 endpoint inbox /api/me/notifications cho member xem và đánh dấu đã đọc thông báo của mình.
// Biết ai gọi qua JwtAuthGuard toàn cục; chỉ MEMBER; account lấy từ phiên đăng nhập, không nhận từ client (US-47-F01).
import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import { AuthPrincipal } from '../auth/auth.types';
import { InboxQueryDto, MarkReadDto } from './notification-inbox.dto';
import { NotificationInboxService } from './notification-inbox.service';

@Controller('me/notifications')
// US-47-TC03: không token/phiên bị thu hồi → 401 (Guard); TRAINER/STAFF/ADMIN → 403.
@Roles('MEMBER')
export class NotificationInboxController {
  constructor(private readonly inbox: NotificationInboxService) {}

  // US-47-TC01, US-47-TC08: danh sách có lọc readState và phân trang.
  @Get()
  list(@CurrentUser() user: AuthPrincipal, @Query() query: InboxQueryDto) {
    return this.inbox.listOwn(user.id, query);
  }

  // Route tĩnh khai báo TRƯỚC ":id" để "unread-count" không bị hiểu thành một id.
  @Get('unread-count')
  unreadCount(@CurrentUser() user: AuthPrincipal) {
    return this.inbox.countUnread(user.id);
  }

  // US-47-TC01, US-47-TC02: id sai định dạng → 400 INVALID_ID, không phải của mình → 404 (kiểm ở service).
  @Get(':id')
  detail(@CurrentUser() user: AuthPrincipal, @Param('id') id: string) {
    return this.inbox.getOwn(user.id, id);
  }

  // US-47-TC06: trả 200 (không phải 201) vì gọi lại không tạo gì mới, chỉ trả readAt lần đầu.
  @Post(':id/read')
  @HttpCode(200)
  markRead(@CurrentUser() user: AuthPrincipal, @Param('id') id: string, @Body() _body: MarkReadDto) {
    return this.inbox.markReadOwn(user.id, id);
  }
}
