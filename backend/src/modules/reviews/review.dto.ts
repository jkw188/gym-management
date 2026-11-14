// Tầng kiểm tra dữ liệu (US-65 bước 2, US-31 bước 1): body/id khi Member gửi/xem đánh giá; query/id khi PT xem đánh giá của mình.
// CHỈ nhận field có khai báo; memberId/trainerId/status/createdAt… → 400 vì ValidationPipe forbidNonWhitelisted (US-65-TC02, US-31-TC02).
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsMongoId, IsOptional, IsString, Max, Min } from 'class-validator';

// US-65-TC02: id sai định dạng → 400.
export class ReviewBookingParamDto {
  @ApiProperty({ example: '6740f1a2b3c4d5e6f7a8b9c0' })
  @IsMongoId({ message: 'id không hợp lệ' }) id!: string;
}

export class CreatePtReviewDto {
  // US-65-F02, US-65-TC05: số nguyên 1–5; 0, 6, 1.5 và chuỗi "4" đều 400 (không tự đổi kiểu).
  @ApiProperty({ example: 4, minimum: 1, maximum: 5 })
  @IsInt() @Min(1) @Max(5) rating!: number;

  // Trim, độ dài ≤ 1000 và ký tự điều khiển do ReviewService kiểm (luật nghiệp vụ F02 nằm ở service).
  @ApiPropertyOptional({ example: 'PT hướng dẫn kỹ', description: 'Tối đa 1000 ký tự sau khi bỏ khoảng trắng hai đầu' })
  @IsOptional() @IsString() comment?: string;
}

// US-31 bước 1 – query của GET /api/me/trainer-reviews. Bước này CHƯA nhận tham số nào: mọi query (trainerId, ownerId…)
// đều nằm ngoài allowlist nên 400, kể cả khi kèm bộ lọc khác (US-31-F01, US-31-TC02). Bước 2 thêm fromDate, toDate, rating, page, limit.
export class TrainerReviewsQueryDto {}

// US-31-TC02: id đánh giá sai định dạng → 400.
export class TrainerReviewParamDto {
  @ApiProperty({ example: '6740f1a2b3c4d5e6f7a8b9c0' })
  @IsMongoId({ message: 'id không hợp lệ' }) id!: string;
}
