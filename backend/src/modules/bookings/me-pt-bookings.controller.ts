// Tầng API (US-27 bước 2): Member xem lịch PT riêng của mình – danh sách theo ngày và chi tiết một buổi.
// Biết ai gọi qua JwtAuthGuard toàn cục; chỉ MEMBER (FixedPermission); chủ thể lấy từ phiên, không nhận memberId từ query.
import { Controller, Get, Param, Query } from '@nestjs/common';
import { CurrentUser } from '../auth/auth.decorators';
import { AuthPrincipal } from '../auth/auth.types';
import { FixedPermission } from '../users/access.policy';
import { MePtBookingsQueryDto } from './me-pt-bookings.dto';
import { MePtBookingsService } from './me-pt-bookings.service';

@Controller('me')
export class MePtBookingsController {
  constructor(private readonly service: MePtBookingsService) {}

  // US-27-TC07, US-27-TC08, US-27-TC10, US-27-TC11
  @Get('pt-bookings')
  @FixedPermission('ptBookings.readOwn')
  list(@CurrentUser() user: AuthPrincipal, @Query() query: MePtBookingsQueryDto) {
    return this.service.list(user.id, query);
  }

  // US-27-TC07, US-27-TC08, US-27-TC10
  @Get('pt-bookings/:id')
  @FixedPermission('ptBookings.readOwn')
  detail(@CurrentUser() user: AuthPrincipal, @Param('id') id: string) {
    return this.service.detail(user.id, id);
  }
}
