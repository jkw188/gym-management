// Tầng API (US-65 bước 2): Member gửi và xem lại đánh giá buổi PT của chính mình.
// Người gọi lấy từ phiên đăng nhập (JwtAuthGuard toàn cục, kiểm account/phiên mỗi request); FixedPermission chặn sai vai trò bằng 403.
// Không có route PATCH/DELETE: đánh giá không sửa sau khi gửi (US-65-F03, US-65-TC07).
import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { IdempotencyKey } from '../../common/decorators/idempotency-key.decorator';
import { CurrentUser } from '../auth/auth.decorators';
import { AuthPrincipal } from '../auth/auth.types';
import { FixedPermission } from '../users/access.policy';
import { CreatePtReviewDto, ReviewBookingParamDto } from './review.dto';
import { ReviewService } from './review.service';

@Controller('me/pt-bookings/:id/review')
export class ReviewController {
  constructor(private readonly reviews: ReviewService) {}

  // US-65-TC01–TC09, TC11: Member chủ booking COMPLETED gửi đánh giá; 201 (mặc định của POST trong Nest).
  @Post()
  @FixedPermission('ptReviews.createOwn')
  create(@CurrentUser() user: AuthPrincipal, @Param() params: ReviewBookingParamDto, @IdempotencyKey() key: string,
    @Body() dto: CreatePtReviewDto) {
    return this.reviews.create({ actorId: user.id, bookingId: params.id, rating: dto.rating, comment: dto.comment, idempotencyKey: key });
  }

  // US-65-TC02, TC04, TC07: xem đánh giá đã gửi hoặc cho biết có gửi được không.
  @Get()
  @FixedPermission('ptReviews.readOwn')
  readOwn(@CurrentUser() user: AuthPrincipal, @Param() params: ReviewBookingParamDto) {
    return this.reviews.readOwn(user.id, params.id);
  }
}
