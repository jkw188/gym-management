// Tầng kiểm tra dữ liệu (US-65 bước 2, US-31 bước 1–2): body/id khi Member gửi/xem đánh giá; query/id khi PT xem đánh giá của mình.
// CHỈ nhận field có khai báo; memberId/trainerId/status/createdAt… → 400 vì ValidationPipe forbidNonWhitelisted (US-65-TC02, US-31-TC02).
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsInt, IsMongoId, IsOptional, IsString, Matches, Max, Min } from 'class-validator';
import { queryInteger } from '../../common/utils/query-integer';
import { MeListQueryDto } from '../memberships/me-memberships.dto';

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

// Ngày Việt Nam dạng YYYY-MM-DD. Ngày có thật, thứ tự và độ dài kỳ do TrainerReviewQueryService kiểm (luật nghiệp vụ).
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

// US-31 bước 2 – query của GET /api/me/trainer-reviews. Allowlist: fromDate, toDate, rating, page, limit.
// page/limit kế thừa khuôn chung (mặc định 1 và 20, tối đa 100). Mọi query khác (trainerId, ownerId…) → 400,
// kể cả khi kèm bộ lọc hợp lệ (US-31-F01, US-31-TC02).
export class TrainerReviewsQueryDto extends MeListQueryDto {
  // US-31-TC05, TC08: không gửi thì mặc định 30 ngày gần nhất.
  @ApiPropertyOptional({ example: '2026-10-16' })
  @IsOptional() @Matches(DATE_ONLY, { message: 'fromDate phải có dạng YYYY-MM-DD' }) fromDate?: string;

  @ApiPropertyOptional({ example: '2026-11-14' })
  @IsOptional() @Matches(DATE_ONLY, { message: 'toDate phải có dạng YYYY-MM-DD' }) toDate?: string;

  // US-31-TC06: lọc điểm nguyên 1–5; 0, 6, 4.5, chữ → 400.
  @ApiPropertyOptional({ minimum: 1, maximum: 5 })
  @IsOptional() @Transform(queryInteger) @IsInt() @Min(1) @Max(5) rating?: number;
}

// US-31-TC02: id đánh giá sai định dạng → 400.
export class TrainerReviewParamDto {
  @ApiProperty({ example: '6740f1a2b3c4d5e6f7a8b9c0' })
  @IsMongoId({ message: 'id không hợp lệ' }) id!: string;
}
