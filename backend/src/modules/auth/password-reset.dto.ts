// Tầng kiểm tra dữ liệu: body của POST /api/auth/password-reset/request và /confirm (US-05).
// Field thừa (accountId, role, email…) bị ValidationPipe từ chối với 400 VALIDATION_ERROR (US-05-TC15).
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, Matches, MaxLength, MinLength, ValidateIf } from 'class-validator';

export class PasswordResetRequestDto {
  // Phone hoặc email; service chuẩn hóa và báo 400 nếu không phải cả hai.
  @ApiProperty({ example: '0901234567' })
  @IsString() @MinLength(1) @MaxLength(190) identifier!: string;

  // US-05-F02: challenge là 32 byte ngẫu nhiên do server tạo, mã hóa base64url thành đúng 43 ký tự.
  @ApiPropertyOptional({ description: 'Challenge của flow đang giữ, gửi kèm khi muốn gửi lại mã' })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString() @Matches(/^[A-Za-z0-9_-]{43}$/) challenge?: string;
}

// Body của POST /api/auth/password-reset/confirm. Độ dài newPassword (12–128 ký tự Unicode, không trim)
// kiểm ở service bằng PasswordService.validate để dùng chung policy EN01-F06.
export class PasswordResetConfirmDto {
  @ApiProperty() @IsString() @Matches(/^[A-Za-z0-9_-]{43}$/) challenge!: string;

  // US-05-F02: OTP là chuỗi đúng 6 chữ số để giữ số 0 ở đầu; gửi dạng số sẽ bị 400 (US-05-TC15).
  @ApiProperty({ example: '012345' }) @IsString() @Matches(/^\d{6}$/) otp!: string;

  @ApiProperty({ format: 'password', writeOnly: true }) @IsString() newPassword!: string;
}

export class PasswordResetConfirmResponseDto {
  @ApiProperty() message!: string;
}

export class PasswordResetRequestResponseDto {
  @ApiProperty() message!: string;
  @ApiProperty() challenge!: string;
}
