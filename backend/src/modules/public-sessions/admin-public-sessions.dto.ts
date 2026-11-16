import { IsIn, IsInt, IsMongoId, IsOptional, IsString, Max, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PublicSessionQueryDto } from './public-sessions.dto';
import { SESSION_STATUSES, SessionStatus, SUBJECT_CODES, SubjectCode } from './public-sessions.types';

export class AdminSessionQueryDto extends PublicSessionQueryDto {
  @ApiPropertyOptional({ enum: SESSION_STATUSES }) @IsOptional() @IsIn(SESSION_STATUSES) status?: SessionStatus;
}

export class CreatePublicSessionDto {
  @ApiProperty({ minLength: 1, maxLength: 120 }) @IsString() title!: string;
  @ApiProperty() @IsMongoId() trainerId!: string;
  @ApiProperty({ enum: SUBJECT_CODES }) @IsIn(SUBJECT_CODES) subjectCode!: SubjectCode;
  @ApiProperty({ minLength: 1, maxLength: 120 }) @IsString() location!: string;
  @ApiProperty({ format: 'date-time', example: '2035-11-16T08:00:00+07:00' }) @IsString() startAt!: string;
  @ApiProperty({ format: 'date-time', example: '2035-11-16T08:45:00+07:00' }) @IsString() endAt!: string;
}

export class SessionVersionDto {
  @ApiProperty({ minimum: 0 }) @IsInt() @Min(0) @Max(Number.MAX_SAFE_INTEGER - 1) version!: number;
}

export class UpdatePublicSessionDto extends CreatePublicSessionDto {
  @ApiProperty({ minimum: 0 }) @IsInt() @Min(0) @Max(Number.MAX_SAFE_INTEGER - 1) version!: number;
}

export class CancelPublicSessionDto extends SessionVersionDto {
  @ApiProperty({ minLength: 10, maxLength: 500 }) @IsString() reason!: string;
}

// Chỉ xem trước, không giữ giờ. Server vẫn kiểm lại trong transaction khi công bố/sửa.
export class PreviewPublicSessionDto extends CreatePublicSessionDto {
  @ApiPropertyOptional() @IsOptional() @IsMongoId() sessionId?: string;
}

export class AdminSessionResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() title!: string;
  @ApiProperty() trainerId!: string;
  @ApiProperty({ type: String, nullable: true }) trainerName!: string | null;
  @ApiProperty({ enum: SUBJECT_CODES }) subjectCode!: SubjectCode;
  @ApiProperty() subjectLabel!: string;
  @ApiProperty() location!: string;
  @ApiProperty({ format: 'date-time' }) startAt!: string;
  @ApiProperty({ format: 'date-time' }) endAt!: string;
  @ApiProperty({ enum: SESSION_STATUSES }) status!: SessionStatus;
  @ApiProperty() ended!: boolean;
  @ApiProperty() version!: number;
  @ApiProperty() createdBy!: string;
  @ApiProperty() updatedBy!: string;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
  @ApiPropertyOptional({ format: 'date-time' }) publishedAt?: string;
  @ApiPropertyOptional({ format: 'date-time' }) cancelledAt?: string;
  @ApiPropertyOptional() cancelledBy?: string;
  @ApiPropertyOptional() cancellationReason?: string;
}
export class AdminSessionPageDto {
  @ApiProperty({ type: [AdminSessionResponseDto] }) items!: AdminSessionResponseDto[];
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
  @ApiProperty() total!: number;
  @ApiProperty() totalPages!: number;
}
export class SessionPreviewResponseDto {
  @ApiProperty({ format: 'date-time' }) startAt!: string;
  @ApiProperty({ format: 'date-time' }) endAt!: string;
  @ApiProperty({ type: [String] }) conflictCodes!: string[];
}
