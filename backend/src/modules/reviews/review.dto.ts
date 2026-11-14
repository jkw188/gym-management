// Tầng kiểm tra dữ liệu (US-65 bước 2): body và id gửi lên khi Member gửi/xem đánh giá buổi PT.
// CHỈ nhận {rating, comment?}; memberId/trainerId/status/createdAt… → 400 vì ValidationPipe forbidNonWhitelisted (US-65-TC02).
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
