// Tầng kiểm tra dữ liệu: định dạng body của POST /api/auth/change-password (US-67).
// Độ dài mật khẩu kiểm ở service để dùng chung một policy trong PasswordService.validate.
import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

// US-67-TC04: ValidationPipe toàn cục từ chối mọi field không khai báo ở đây (accountId, role, confirmPassword...).
export class ChangePasswordDto {
  @ApiProperty({ format: 'password', writeOnly: true })
  @IsString() @MinLength(1) currentPassword!: string;

  @ApiProperty({ format: 'password', writeOnly: true, minLength: 12, maxLength: 128 })
  @IsString() newPassword!: string;
}
