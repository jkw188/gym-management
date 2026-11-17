import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { FixedPermission } from '../users/access.policy';
import { TrainerReviewParamDto } from './review.dto';
import { AdminTrainerReviewDetailDto, AdminTrainerReviewPageDto, AdminTrainerReviewsQueryDto, AdminTrainerSummaryPageDto, EmptyReviewQueryDto } from './admin-trainer-reviews.dto';
import { AdminTrainerReviewsService } from './admin-trainer-reviews.service';

@ApiTags('Admin trainer reviews')
@ApiBearerAuth()
@Controller('admin/trainer-reviews')
@FixedPermission('trainers.reviews.read')
export class AdminTrainerReviewsController {
  constructor(private readonly service: AdminTrainerReviewsService) {}

  @Get('summary')
  @ApiOperation({ summary: 'US-33 / UC-34: Tổng hợp theo PT, totals trên toàn tập lọc' })
  @ApiOkResponse({ type: AdminTrainerSummaryPageDto })
  summary(@Query() query: AdminTrainerReviewsQueryDto) { return this.service.summary(query); }

  @Get()
  @ApiOperation({ summary: 'US-33: Nhận xét gốc, kỳ gửi theo ngày VN' })
  @ApiOkResponse({ type: AdminTrainerReviewPageDto })
  list(@Query() query: AdminTrainerReviewsQueryDto) { return this.service.list(query); }

  @Get(':id')
  @ApiOperation({ summary: 'US-33: Đối chiếu review và mã buổi, chỉ đọc' })
  @ApiOkResponse({ type: AdminTrainerReviewDetailDto })
  detail(@Param() params: TrainerReviewParamDto, @Query() _query: EmptyReviewQueryDto) { return this.service.detail(params.id); }
}
