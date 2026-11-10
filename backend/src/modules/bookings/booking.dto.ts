// Tầng kiểm tra dữ liệu (US-28 bước 3): body của POST /api/me/pt-bookings – Member đặt một slot PT.
// Chỉ nhận 4 field; ValidationPipe toàn cục bật forbidNonWhitelisted nên endAt, memberId, status, price, trainerName, location → 400 (US-28-F01).
import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';

const OBJECT_ID = /^[0-9a-f]{24}$/i;

// US-28-TC03: giờ ISO 8601 bắt buộc có Z hoặc offset; tháng 01–12, giờ 00–23, phút 00–59; giây nếu có phải là 00 (slot luôn tròn phút).
// Ví dụ hợp lệ: 2026-12-01T09:00+07:00, 2026-12-01T09:00:00+07:00, 2026-12-01T02:00:00.000Z.
// Ngày có thật hay không (ví dụ 30/02) do BookingService kiểm bằng ShiftIntervalService.parseInstant.
const START_AT = /^\d{4}-(0[1-9]|1[0-2])-\d{2}T([01]\d|2[0-3]):[0-5]\d(:00(\.0{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

export class CreatePtBookingDto {
  @ApiProperty({ example: '6730a1b2c3d4e5f601234567', description: 'Gói PT của chính Member' })
  @IsString() @Matches(OBJECT_ID) membershipId!: string;

  @ApiProperty({ example: '6730a1b2c3d4e5f601234568' })
  @IsString() @Matches(OBJECT_ID) trainerId!: string;

  @ApiProperty({ example: '6730a1b2c3d4e5f601234569' })
  @IsString() @Matches(OBJECT_ID) shiftId!: string;

  // endAt KHÔNG nhận từ client: server tự tính startAt + 60 phút (US-28-F02).
  @ApiProperty({ example: '2026-12-01T09:00:00+07:00' })
  @IsString() @Matches(START_AT) startAt!: string;
}
