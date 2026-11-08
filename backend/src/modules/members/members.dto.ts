// Tầng kiểm tra dữ liệu (US-09 bước 1): body của POST /api/members.
// Chỉ kiểm kiểu cơ bản; chuẩn hóa phone, độ dài họ tên, ngày sinh hợp lệ/không tương lai nằm ở MembersService.
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmpty, IsOptional, IsString } from 'class-validator';

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
