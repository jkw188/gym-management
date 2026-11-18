import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsInt, IsISO8601, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';
import { ShiftListQueryDto } from '../shifts/shifts.dto';

const trim = ({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value;
export class AttendanceIdDto {
  @ApiProperty() @Matches(/^[a-f\d]{24}$/i) id!: string;
}
export class AttendanceListDto extends ShiftListQueryDto {
  @ApiPropertyOptional() @IsOptional() @Matches(/^[a-f\d]{24}$/i) trainerId?: string;
}
export class AttendanceNoteDto {
  @ApiPropertyOptional({ maxLength: 255 }) @ValidateIf((_o, value) => value !== undefined)
  @Transform(trim) @IsString() @MaxLength(255) note?: string;
}
export class AttendanceCheckoutDto extends AttendanceNoteDto {
  @ApiProperty({ minimum: 0 }) @IsInt() @Min(0) @Max(Number.MAX_SAFE_INTEGER - 1) version!: number;
}
export class AttendanceCorrectionDto extends AttendanceNoteDto {
  @ApiPropertyOptional({ minimum: 0 }) @ValidateIf((_o, value) => value !== undefined)
  @IsInt() @Min(0) @Max(Number.MAX_SAFE_INTEGER - 1) version?: number;
  @ApiProperty({ format: 'date-time' }) @IsISO8601({ strict: true }) @Matches(/T.*(?:Z|[+-]\d{2}:\d{2})$/i) checkInAt!: string;
  @ApiPropertyOptional({ format: 'date-time' }) @ValidateIf((_o, value) => value !== undefined)
  @IsISO8601({ strict: true }) @Matches(/T.*(?:Z|[+-]\d{2}:\d{2})$/i) checkOutAt?: string;
  @ApiProperty({ minLength: 10, maxLength: 500 }) @Transform(trim) @IsString() @MinLength(10) @MaxLength(500) reason!: string;
}
export class EmptyAttendanceQueryDto {}
