import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { ROLE_CODES, RoleCode } from '../users/schemas/role.schema';

export class LoginDto {
  @ApiProperty({ example: '0901234567' })
  @IsString() @MinLength(1) @MaxLength(64) phone!: string;

  @ApiProperty({ format: 'password', writeOnly: true, maxLength: 128 })
  @IsString() @MinLength(1) @MaxLength(128) password!: string;
}
export class PrincipalDto {
  @ApiProperty() id!: string;
  @ApiProperty() fullName!: string;
  @ApiProperty() phone!: string;
  @ApiPropertyOptional() email?: string;
  @ApiProperty({ enum: ROLE_CODES }) roleCode!: RoleCode;
}
export class AuthResponseDto {
  @ApiProperty() accessToken!: string;
  @ApiProperty({ enum: ['Bearer'] }) tokenType!: 'Bearer';
  @ApiProperty() expiresIn!: number;
  @ApiProperty({ type: PrincipalDto }) user!: PrincipalDto;
}
