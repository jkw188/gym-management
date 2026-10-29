import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsString, Max, MaxLength, Min, ValidateIf } from 'class-validator';
import { ROLE_CODES, RoleCode } from '../users/schemas/role.schema';
import { AccountStatus } from '../users/schemas/account.schema';

const present = (_object: unknown, value: unknown) => value !== undefined;
const presentAndNotNull = (_object: unknown, value: unknown) => value !== undefined && value !== null;

export class UpdateProfileDto {
  @ApiPropertyOptional({ minLength: 2, maxLength: 120 })
  @ValidateIf(present) @IsString() fullName?: string;

  @ApiPropertyOptional({ maxLength: 32 })
  @ValidateIf(present) @IsString() @MaxLength(32) phone?: string;

  @ApiPropertyOptional({ maxLength: 190, format: 'email', nullable: true })
  @ValidateIf(presentAndNotNull) @IsString() email?: string | null;

  @ApiPropertyOptional({ example: '2000-12-31', nullable: true })
  @ValidateIf(presentAndNotNull) @IsString() birthDate?: string | null;

  @ApiPropertyOptional({ maxLength: 255, nullable: true })
  @ValidateIf(presentAndNotNull) @IsString() address?: string | null;

  @ApiProperty({ minimum: 0, maximum: 2147483647 })
  @IsInt() @Min(0) @Max(2147483647) version!: number;
}

export class ProfileResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() fullName!: string;
  @ApiProperty() phone!: string;
  @ApiPropertyOptional() email?: string;
  @ApiPropertyOptional({ example: '2000-12-31' }) birthDate?: string;
  @ApiPropertyOptional() address?: string;
  @ApiProperty({ enum: ROLE_CODES }) roleCode!: RoleCode;
  @ApiProperty({ enum: ['ACTIVE', 'LOCKED'] }) status!: AccountStatus;
  @ApiProperty({ minimum: 0 }) version!: number;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: Date;
  @ApiProperty({ type: String, format: 'date-time' }) updatedAt!: Date;
}

export class UpdateProfileResponseDto {
  @ApiProperty({ type: ProfileResponseDto }) profile!: ProfileResponseDto;
  @ApiProperty() reauthenticationRequired!: boolean;
}
