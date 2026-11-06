// Tầng kiểm tra dữ liệu (US-24 bước 1): body của POST và PATCH /api/me/work-shifts.
// Chỉ kiểm kiểu cơ bản; luật thời gian (offset, 60 phút, nửa đêm…) nằm ở ShiftIntervalService.
// ValidationPipe toàn cục bật forbidNonWhitelisted nên trainerId, status, createdBy gửi lên đều bị 400 (US-24-F01).
import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsString, Min } from 'class-validator';

export class CreateShiftDto {
  // Chuỗi ISO 8601 có Z hoặc offset, ví dụ 2026-12-01T08:10:00+07:00.
  @ApiProperty({ example: '2026-12-01T08:10:00+07:00' })
  @IsString() startAt!: string;

  @ApiProperty({ example: '2026-12-01T10:40:00+07:00' })
  @IsString() endAt!: string;

  @ApiProperty({ example: 'Phòng PT 1', maxLength: 120 })
  @IsString() location!: string;
}

// PATCH gửi DTO đầy đủ kèm version đang xem để kiểm CAS (US-24-F04).
export class UpdateShiftDto extends CreateShiftDto {
  @ApiProperty({ example: 0, minimum: 0 })
  @IsInt() @Min(0) version!: number;
}
