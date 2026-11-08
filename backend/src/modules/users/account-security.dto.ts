import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsString, Length, Max, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { AccountStatus } from './schemas/account.schema';
import { UserResponseDto } from './users.dto';
import { RoleCode, ROLE_CODES } from './schemas/role.schema';

export class ChangeStatusDto {
  @ApiProperty({ enum: ['ACTIVE', 'LOCKED'] })
  @IsIn(['ACTIVE', 'LOCKED']) status!: AccountStatus;

  @ApiProperty({ minimum: 0, maximum: 2147483647 })
  @IsInt() @Min(0) @Max(2147483647) version!: number;

  @ApiProperty({ minLength: 10, maxLength: 500 })
  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value)
  @IsString() @Length(10, 500) reason!: string;
}

export class ChangeSecurityResponseDto {
  @ApiProperty({ type: UserResponseDto }) user!: UserResponseDto;
  @ApiProperty() changed!: boolean;
  @ApiProperty() reauthenticationRequired!: boolean;
}

export class ChangeRoleDto {
  @ApiProperty({ enum: ROLE_CODES })
  @IsIn(ROLE_CODES) roleCode!: RoleCode;

  @ApiProperty({ minimum: 0, maximum: 2147483647 })
  @IsInt() @Min(0) @Max(2147483647) version!: number;

  @ApiProperty({ minLength: 10, maxLength: 500 })
  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value)
  @IsString() @Length(10, 500) reason!: string;
}
