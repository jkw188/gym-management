import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, Length, MaxLength, ValidateIf } from 'class-validator';

export class RegisterDto {
  @ApiProperty({ minLength: 2, maxLength: 120, description: 'Trim và gộp khoảng trắng trước khi kiểm tra độ dài' })
  @IsString() fullName!: string;

  @ApiProperty({ maxLength: 32, example: '0901234567' })
  @IsString() @MaxLength(32) phone!: string;

  @ApiPropertyOptional({ maxLength: 190, format: 'email' })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString() email?: string;

  @ApiProperty({ format: 'password', writeOnly: true, minLength: 12, maxLength: 128 })
  @IsString() @Length(12, 128) password!: string;
}

export class RegisterResponseDto {
  @ApiProperty({ pattern: '^[a-f0-9]{24}$' }) id!: string;
  @ApiProperty({ enum: ['LOGIN'] }) nextAction!: 'LOGIN';
}
