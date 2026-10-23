import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsString, Length, Max, MaxLength, Min, ValidateIf } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ROLE_CODES, RoleCode } from './schemas/role.schema';
import { AccountStatus } from './schemas/account.schema';

export class CreateUserDto {
  @ApiProperty({ minLength: 2, maxLength: 120 })
  @IsString() fullName!: string;

  @ApiProperty({ maxLength: 32, example: '0901234567' })
  @IsString() @MaxLength(32) phone!: string;

  @ApiPropertyOptional({ maxLength: 190, format: 'email' })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString() email?: string;

  @ApiProperty({ format: 'password', writeOnly: true, minLength: 12, maxLength: 128 })
  @IsString() @Length(12, 128) password!: string;

  @ApiProperty({ enum: ROLE_CODES })
  @IsIn(ROLE_CODES) roleCode!: RoleCode;
}

export class UpdateUserDto {
  @ApiPropertyOptional({ minLength: 2, maxLength: 120 })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString() fullName?: string;

  @ApiPropertyOptional({ maxLength: 32 })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString() @MaxLength(32) phone?: string;

  @ApiPropertyOptional({ maxLength: 190, format: 'email', nullable: true })
  @ValidateIf((_object, value: unknown) => value !== undefined && value !== null)
  @IsString() email?: string | null;

  @ApiProperty({ minimum: 0, maximum: 2147483647 })
  @IsInt() @Min(0) @Max(2147483647) version!: number;
}

function queryInteger({ value }: { value: unknown }): unknown {
  return typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : value;
}

export class ListUsersDto {
  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @Transform(queryInteger) @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) page = 1;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @Transform(queryInteger) @IsInt() @Min(1) @Max(100) limit = 20;

  @ApiPropertyOptional({ maxLength: 120 })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString() @MaxLength(120) q?: string;

  @ApiPropertyOptional({ enum: ROLE_CODES })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsIn(ROLE_CODES) roleCode?: RoleCode;

  @ApiPropertyOptional({ enum: ['ACTIVE', 'LOCKED'] })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsIn(['ACTIVE', 'LOCKED']) status?: AccountStatus;
}

export class UserResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() fullName!: string;
  @ApiProperty() phone!: string;
  @ApiPropertyOptional() email?: string;
  @ApiProperty({ enum: ROLE_CODES }) roleCode!: RoleCode;
  @ApiProperty() roleName!: string;
  @ApiProperty({ enum: ['ACTIVE', 'LOCKED'] }) status!: AccountStatus;
  @ApiProperty({ minimum: 0 }) version!: number;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: Date;
  @ApiProperty({ type: String, format: 'date-time' }) updatedAt!: Date;
}

export class UsersPageDto {
  @ApiProperty({ type: [UserResponseDto] }) items!: UserResponseDto[];
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
  @ApiProperty() total!: number;
  @ApiProperty() totalPages!: number;
}

export class UserRoleDto {
  @ApiProperty({ enum: ROLE_CODES }) code!: RoleCode;
  @ApiProperty() name!: string;
}

export class UserRolesDto {
  @ApiProperty({ type: [UserRoleDto] }) items!: UserRoleDto[];
}
