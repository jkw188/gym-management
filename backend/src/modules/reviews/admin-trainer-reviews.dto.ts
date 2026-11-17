import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsMongoId, IsOptional } from 'class-validator';
import { TrainerReviewsQueryDto } from './review.dto';

export class AdminTrainerReviewsQueryDto extends TrainerReviewsQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsMongoId() trainerId?: string;
}
export class EmptyReviewQueryDto {}

export class ReviewMetricsDto {
  @ApiProperty() reviewCount!: number;
  @ApiProperty() ratingSum!: number;
  @ApiProperty({ type: Number, nullable: true }) averageRating!: number | null;
  @ApiProperty({ example: { '1': 0, '2': 0, '3': 0, '4': 1, '5': 2 }, additionalProperties: { type: 'number' } }) distribution!: Record<string, number>;
}
export class AdminTrainerReviewDto {
  @ApiProperty() id!: string;
  @ApiProperty() trainerId!: string;
  @ApiProperty({ description: 'Tên PT chụp lúc gửi, không thay bằng tên hiện tại' }) trainerNameSnapshot!: string;
  @ApiProperty() memberDisplayName!: string;
  @ApiProperty({ minimum: 1, maximum: 5 }) rating!: number;
  @ApiProperty() comment!: string;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ example: { id: '6740f1a2b3c4d5e6f7a8b9c0', startAt: '2026-11-01T02:00:00.000Z', endAt: '2026-11-01T03:00:00.000Z' } })
  booking!: { id: string; startAt: string; endAt: string };
}
export class AdminTrainerReviewDetailDto extends AdminTrainerReviewDto {
  @ApiProperty({ format: 'date-time' }) asOf!: string;
}
export class AdminTrainerSummaryDto extends ReviewMetricsDto {
  @ApiProperty() trainerId!: string;
  @ApiProperty({ description: 'Tên PT hiện tại; tên lịch sử nằm ở review gốc' }) currentTrainerName!: string;
  @ApiProperty({ type: String, nullable: true }) status!: string | null;
}
class ReviewRangeDto {
  @ApiProperty() fromDate!: string;
  @ApiProperty() toDate!: string;
}
class ReviewPageDto {
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
  @ApiProperty() total!: number;
  @ApiProperty() totalPages!: number;
  @ApiProperty({ format: 'date-time' }) asOf!: string;
  @ApiProperty({ type: ReviewRangeDto }) range!: ReviewRangeDto;
  @ApiProperty() invalidReviewCount!: number;
  @ApiProperty({ type: ReviewMetricsDto }) totals!: ReviewMetricsDto;
}
export class AdminTrainerSummaryPageDto extends ReviewPageDto {
  @ApiProperty({ type: [AdminTrainerSummaryDto] }) items!: AdminTrainerSummaryDto[];
}
export class AdminTrainerReviewPageDto extends ReviewPageDto {
  @ApiProperty({ type: [AdminTrainerReviewDto] }) items!: AdminTrainerReviewDto[];
}
