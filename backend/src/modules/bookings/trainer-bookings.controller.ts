// Tầng API (US-64 bước 4): GET /api/me/trainer-bookings – PT xem buổi dạy của chính mình.
// Chỉ TRAINER (ptBookings.readTrainerOwn); Member/Staff/Admin → 403. PT lấy từ phiên đăng nhập, không nhận từ client.
import { Controller, Get, Query } from '@nestjs/common';
import { CurrentUser } from '../auth/auth.decorators';
import { AuthPrincipal } from '../auth/auth.types';
import { FixedPermission } from '../users/access.policy';
import { TrainerBookingsQueryDto } from './trainer-bookings.dto';
import { TrainerBookingsService } from './trainer-bookings.service';

@Controller('me/trainer-bookings')
export class TrainerBookingsController {
  constructor(private readonly service: TrainerBookingsService) {}

  // US-64-TC15
  @Get()
  @FixedPermission('ptBookings.readTrainerOwn')
  list(@CurrentUser() user: AuthPrincipal, @Query() query: TrainerBookingsQueryDto) {
    return this.service.listOwn(user.id, query);
  }
}
