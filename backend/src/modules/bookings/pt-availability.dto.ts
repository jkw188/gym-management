// Tầng kiểm tra dữ liệu (US-27 bước 1): query của GET /api/me/pt-trainers và /api/me/pt-trainers/:id/availability.
// ValidationPipe toàn cục bật forbidNonWhitelisted nên memberId, accountId hay field lạ đều bị 400.
// Ngày có thật và khoảng tối đa 31 ngày do ShiftIntervalService.vietnamDateRange kiểm.
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsMongoId, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { MeListQueryDto } from '../memberships/me-memberships.dto';

// Ngày Việt Nam dạng YYYY-MM-DD.
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

// Danh mục PT: page/limit kế thừa khuôn chung (mặc định 1 và 20, tối đa 100); q tìm theo tên PT.
export class PtTrainersQueryDto extends MeListQueryDto {
  @ApiPropertyOptional({ example: 'Bình' })
  @IsOptional() @IsString() @MaxLength(100) q?: string;
}

export class PtAvailabilityQueryDto {
  // Không gửi thì mặc định tuần hiện tại từ thứ Hai (spec mục 2).
  @ApiPropertyOptional({ example: '2026-12-01' })
  @IsOptional() @Matches(DATE_ONLY, { message: 'fromDate phải có dạng YYYY-MM-DD' }) fromDate?: string;

  @ApiPropertyOptional({ example: '2026-12-07' })
  @IsOptional() @Matches(DATE_ONLY, { message: 'toDate phải có dạng YYYY-MM-DD' }) toDate?: string;

  // US-27-F04: gói của chính Member dùng để đánh giá bookable; không gửi thì chỉ xem giờ tham khảo.
  @ApiPropertyOptional({ example: '6650f0c2a1b2c3d4e5f60718' })
  @IsOptional() @IsMongoId({ message: 'membershipId không hợp lệ' }) membershipId?: string;
}
