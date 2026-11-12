// Tầng API (US-30 bước 1): GET /api/me/trainees – PT xem danh sách học viên có booking với mình.
// Chỉ TRAINER (trainees.readRelated); Member/Staff/Admin → 403. PT lấy từ phiên đăng nhập, không nhận từ client.
import { Controller, Get, Query } from '@nestjs/common';
import { CurrentUser } from '../auth/auth.decorators';
import { AuthPrincipal } from '../auth/auth.types';
import { FixedPermission } from '../users/access.policy';
import { TraineesQueryDto } from './trainees.dto';
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
}
