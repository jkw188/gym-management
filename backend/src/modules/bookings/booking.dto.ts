// Tầng kiểm tra dữ liệu (US-28 bước 3, US-29 bước 3): body của POST /api/me/pt-bookings (đặt slot PT) và body của lệnh hủy buổi PT.
// US-64 bước 2: thêm id trên đường dẫn và body {version} của lệnh PT xác nhận buổi đã dạy.
// US-64 bước 3: thêm body {version, action, reason} của lệnh Admin xử lý sai.
// Chỉ nhận 4 field; ValidationPipe toàn cục bật forbidNonWhitelisted nên endAt, memberId, status, price, trainerName, location → 400 (US-28-F01).
import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsInt, IsMongoId, IsString, Matches, Min } from 'class-validator';

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

// US-29 bước 3: body của POST /api/me/pt-bookings/:id/cancel và POST /api/pt-bookings/:id/cancel.
// CHỈ nhận {version, reason}; field khác (now, clientNow, status…) → 400 (US-29-TC02, TC06): server không dùng giờ client.
// Độ dài lý do sau trim (10–500) do CancelBookingService kiểm, để mọi đường gọi dùng chung một luật.
export class CancelPtBookingDto {
  // Version client đang thấy; số nguyên ≥ 0, chuỗi "0" cũng bị 400 vì không tự đổi kiểu.
  @ApiProperty({ example: 0 })
  @IsInt() @Min(0) version!: number;

  @ApiProperty({ example: 'Bận việc gia đình đột xuất', description: 'Lý do hủy, 10–500 ký tự sau khi bỏ khoảng trắng hai đầu' })
  @IsString() reason!: string;
}

// US-64-TC02: :id trên đường dẫn phải là ObjectId (24 ký tự hex); sai định dạng → 400 trước khi vào service.
export class PtBookingIdParamDto {
  @IsMongoId({ message: 'id không hợp lệ' }) id!: string;
}

// US-64 bước 2: body của POST /api/me/pt-bookings/:id/complete. CHỈ nhận {version}; field khác → 400.
// Giờ xác nhận, gói bị trừ, người xác nhận đều do server xác định, không nhận từ client (US-64-F01).
export class CompletePtBookingDto {
  // US-64-TC06: số nguyên ≥ 0; thiếu, âm hoặc không phải số nguyên → 400.
  @ApiProperty({ example: 0 })
  @IsInt() @Min(0) version!: number;
}

// US-64 bước 3: body của POST /api/admin/pt-bookings/:id/corrections. CHỈ nhận {version, action, reason}; field khác → 400.
// Không cho chọn status tùy ý: chỉ hai hành động COMPLETE (xác nhận hỗ trợ) và REOPEN (rút xác nhận sai).
// Độ dài lý do sau trim (10–500) do CorrectBookingService kiểm.
export class CorrectPtBookingDto {
  @ApiProperty({ example: 1 })
  @IsInt() @Min(0) version!: number;

  @ApiProperty({ enum: ['COMPLETE', 'REOPEN'] })
  @IsIn(['COMPLETE', 'REOPEN']) action!: 'COMPLETE' | 'REOPEN';

  @ApiProperty({ example: 'PT đã dạy, có xác nhận chữ ký học viên tại quầy', description: '10–500 ký tự sau khi bỏ khoảng trắng hai đầu' })
  @IsString() reason!: string;
}
