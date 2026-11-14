// Tầng API (US-31 bước 1–2): /api/me/trainer-reviews – PT xem đánh giá học viên gửi cho các buổi mình dạy.
// Chỉ TRAINER (trainers.reviews.readOwn); Member/Staff/Admin → 403. Không có route PATCH/DELETE: PT không sửa/xóa review (US-31-F04).
import { Controller, Get, Param, Query } from '@nestjs/common';
import { CurrentUser } from '../auth/auth.decorators';
import { AuthPrincipal } from '../auth/auth.types';
import { FixedPermission } from '../users/access.policy';
import { TrainerReviewParamDto, TrainerReviewsQueryDto } from './review.dto';
import { TrainerReviewQueryService } from './trainer-review-query.service';

@Controller('me/trainer-reviews')
export class TrainerReviewQueryController {
  constructor(private readonly service: TrainerReviewQueryService) {}

  // US-31-TC01 đến TC08. Query ngoài allowlist (trainerId…) bị ValidationPipe chặn 400 trước khi vào service.
  @Get()
  @FixedPermission('trainers.reviews.readOwn')
  list(@CurrentUser() user: AuthPrincipal, @Query() query: TrainerReviewsQueryDto) {
    return this.service.listOwn(user.id, query);
  }

  // US-31-TC01, TC02, TC04: chi tiết một đánh giá của chính PT.
  @Get(':id')
  @FixedPermission('trainers.reviews.readOwn')
  detail(@CurrentUser() user: AuthPrincipal, @Param() params: TrainerReviewParamDto) {
    return this.service.getOwn(user.id, params.id);
  }
}
