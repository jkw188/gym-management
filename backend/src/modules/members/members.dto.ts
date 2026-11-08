// Tầng kiểm tra dữ liệu (US-09 bước 1–3): body của POST /api/members, query tra account và body liên kết.
// Chỉ kiểm kiểu cơ bản; chuẩn hóa phone, độ dài họ tên, ngày sinh hợp lệ/không tương lai nằm ở MembersService.
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmpty, IsIn, IsInt, IsMongoId, IsOptional, IsString, Min } from 'class-validator';
import { VERIFICATION_METHODS, VerificationMethod } from './schemas/member-link-event.schema';

// Thông báo khi client gửi field do server quản lý.
const SERVER_OWNED = { message: 'Trường do hệ thống quản lý, không được gửi lên' };

export class CreateMemberDto {
  @ApiProperty({ example: 'Nguyễn Văn A', minLength: 2, maxLength: 120 })
  @IsString() fullName!: string;

  @ApiProperty({ example: '0901234567' })
  @IsString() phone!: string;

  @ApiPropertyOptional({ example: '1995-05-20' })
  @IsOptional() @IsString() birthDate?: string;

  @ApiPropertyOptional({ example: '12 Lê Lợi, Quận 1', maxLength: 255 })
  @IsOptional() @IsString() address?: string;

  // US-09-F02, US-09-TC03: mã, ID, version, tài khoản và trường gói do server quản lý. Khai báo rõ ở đây để
  // client gửi lên thì bị 400 kèm đúng tên field (field lạ khác vẫn bị chặn bởi ValidationPipe toàn cục).
  @IsEmpty(SERVER_OWNED) id?: never;
  @IsEmpty(SERVER_OWNED) memberCode?: never;
  @IsEmpty(SERVER_OWNED) accountId?: never;
  @IsEmpty(SERVER_OWNED) version?: never;
  @IsEmpty(SERVER_OWNED) planId?: never;
  @IsEmpty(SERVER_OWNED) sessionsQuota?: never;
}

// US-09 bước 2: query của GET /api/members/link-candidates. Chỉ nhận phone đầy đủ; chuẩn hóa ở service.
// Không có query tên: gửi name hay field lạ khác đều bị ValidationPipe toàn cục trả 400 (US-09-TC08).
export class LinkCandidatesQueryDto {
  @ApiProperty({ example: '0901234567' })
  @IsString() phone!: string;
}

// US-09 bước 3: body của POST /api/members/:id/link. Không có verifiedBy/verifiedAt: gửi lên bị 400 (US-09-TC08).
// Độ dài ghi nhận 10–500 (sau khi bỏ khoảng trắng hai đầu) kiểm ở MembersService.
export class LinkMemberDto {
  @ApiProperty({ example: '6650aaaaaaaaaaaaaaaaaaaa' })
  @IsMongoId() accountId!: string;

  // Version hồ sơ nhân viên đang xem, dùng kiểm "đúng version" (CAS).
  @ApiProperty({ example: 0, minimum: 0 })
  @IsInt() @Min(0) version!: number;

  // US-09-TC09: chỉ hai cách đối chiếu trực tiếp tại quầy; không có "tự xác minh".
  @ApiProperty({ enum: VERIFICATION_METHODS })
  @IsIn(VERIFICATION_METHODS) verificationMethod!: VerificationMethod;

  @ApiProperty({ example: 'Khách mở ứng dụng, đối chiếu tên và số điện thoại tại quầy', minLength: 10, maxLength: 500 })
  @IsString() verificationNote!: string;
}
