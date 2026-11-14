// Tầng API (US-30 bước 1–2): /api/me/trainees – PT xem học viên có booking với mình, hồ sơ tối thiểu, lịch riêng và gói liên quan.
// Chỉ TRAINER (trainees.readRelated); Member/Staff/Admin → 403. PT lấy từ phiên đăng nhập, không nhận từ client.
import { Controller, Get, Param, Query } from '@nestjs/common';
import { CurrentUser } from '../auth/auth.decorators';
import { AuthPrincipal } from '../auth/auth.types';
import { FixedPermission } from '../users/access.policy';
import { TraineeBookingsQueryDto, TraineeMembershipsQueryDto, TraineesQueryDto } from './trainees.dto';
import { TraineeQueryService } from './trainees.service';

@Controller('me/trainees')
export class TraineesController {
  constructor(private readonly service: TraineeQueryService) {}

  // US-30-TC01 đến TC05, TC08, TC11
  @Get()
  @FixedPermission('trainees.readRelated')
  list(@CurrentUser() user: AuthPrincipal, @Query() query: TraineesQueryDto) {
    return this.service.listOwn(user.id, query);
  }

  // US-30-TC02 đến TC04, TC08, TC11: hồ sơ tối thiểu.
  @Get(':memberId')
  @FixedPermission('trainees.readRelated')
  detail(@CurrentUser() user: AuthPrincipal, @Param('memberId') memberId: string) {
    return this.service.getOwnTrainee(user.id, memberId);
  }

  // US-30-TC05, TC10, TC11: lịch của học viên với chính PT.
  @Get(':memberId/bookings')
  @FixedPermission('trainees.readRelated')
  bookings(@CurrentUser() user: AuthPrincipal, @Param('memberId') memberId: string, @Query() query: TraineeBookingsQueryDto) {
    return this.service.listTraineeBookings(user.id, memberId, query);
  }

  // US-30-TC06, TC07, TC10, TC11: gói liên quan kèm quota.
  @Get(':memberId/memberships')
  @FixedPermission('trainees.readRelated')
  memberships(@CurrentUser() user: AuthPrincipal, @Param('memberId') memberId: string, @Query() query: TraineeMembershipsQueryDto) {
    return this.service.listTraineeMemberships(user.id, memberId, query);
  }
}
