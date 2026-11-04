// Tầng kiểm tra dữ liệu: body của POST /api/auth/password-reset/request (US-05).
// Field thừa (accountId, role, email…) bị ValidationPipe từ chối với 400 VALIDATION_ERROR (US-05-TC15).
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class PasswordResetRequestDto {
  // Phone hoặc email; service chuẩn hóa và báo 400 nếu không phải cả hai.
  @ApiProperty({ example: '0901234567' })
  @IsString() @MinLength(1) @MaxLength(190) identifier!: string;

  // US-05-F02: challenge là 32 byte ngẫu nhiên do server tạo, mã hóa base64url thành đúng 43 ký tự.
  @ApiPropertyOptional({ description: 'Challenge của flow đang giữ, gửi kèm khi muốn gửi lại mã' })
  @IsOptional() @IsString() @Matches(/^[A-Za-z0-9_-]{43}$/) challenge?: string;
}

export class PasswordResetRequestResponseDto {
  @ApiProperty() message!: string;
  @ApiProperty() challenge!: string;
}
