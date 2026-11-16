import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsMongoId, IsString, Length, Max, MaxLength, Min, ValidateIf } from 'class-validator';
import { queryInteger } from '../../common/utils/query-integer';
import { TRAINER_STATUSES, TrainerStatus } from './schemas/trainer.schema';

const present = (_object: unknown, value: unknown) => value !== undefined;
const trim = ({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value;
export class TrainerPaginationDto {
  @ApiPropertyOptional({ default: 1 }) @Transform(queryInteger) @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) page = 1;
  @ApiPropertyOptional({ default: 20, maximum: 100 }) @Transform(queryInteger) @IsInt() @Min(1) @Max(100) limit = 20;
}
export class TrainerListQueryDto extends TrainerPaginationDto {
  @ApiPropertyOptional({ maxLength: 120 }) @ValidateIf(present) @IsString() @MaxLength(120) q?: string;
  @ApiPropertyOptional({ enum: TRAINER_STATUSES }) @ValidateIf(present) @IsIn(TRAINER_STATUSES) status?: TrainerStatus;
}
export const BLOCKER_KINDS = ['BOOKING', 'SHIFT', 'PUBLIC_SESSION'] as const;
export type BlockerKind = typeof BLOCKER_KINDS[number];
export class TrainerBlockerQueryDto extends TrainerPaginationDto {
  @ApiPropertyOptional({ enum: BLOCKER_KINDS }) @ValidateIf(present) @IsIn(BLOCKER_KINDS) kind?: BlockerKind;
}
export class CreateTrainerDto {
  @ApiProperty() @IsMongoId() accountId!: string;
  @ApiProperty({ minLength: 1, maxLength: 255 }) @Transform(trim) @IsString() @Length(1, 255) specialty!: string;
  @ApiProperty({ enum: TRAINER_STATUSES }) @IsIn(TRAINER_STATUSES) status!: TrainerStatus;
}
export class UpdateTrainerDto {
  @ApiProperty({ minimum: 0, maximum: 2147483647 }) @IsInt() @Min(0) @Max(2147483647) version!: number;
  @ApiPropertyOptional({ minLength: 1, maxLength: 255 }) @ValidateIf(present) @Transform(trim) @IsString() @Length(1, 255) specialty?: string;
  @ApiPropertyOptional({ enum: TRAINER_STATUSES }) @ValidateIf(present) @IsIn(TRAINER_STATUSES) status?: TrainerStatus;
}
export class EmptyTrainerQueryDto {}

export class TrainerSummaryDto {
  @ApiProperty() id!: string;
  @ApiProperty() accountId!: string;
  @ApiProperty() fullName!: string;
  @ApiProperty() specialty!: string;
  @ApiProperty({ enum: TRAINER_STATUSES }) status!: TrainerStatus;
  @ApiProperty({ minimum: 0 }) version!: number;
}
export class TrainerDetailDto extends TrainerSummaryDto {
  @ApiProperty() phone!: string;
  @ApiPropertyOptional() email?: string;
  @ApiProperty({ type: String, nullable: true }) accountStatus!: string | null;
  @ApiProperty({ type: String, nullable: true }) roleCode!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) createdAt!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) updatedAt!: string | null;
}
export class TrainerPageDto extends TrainerPaginationDto {
  @ApiProperty({ type: [TrainerSummaryDto] }) items!: TrainerSummaryDto[];
  @ApiProperty() total!: number;
  @ApiProperty() totalPages!: number;
}
export class TrainerBlockerDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: BLOCKER_KINDS }) kind!: BlockerKind;
  @ApiProperty({ format: 'date-time' }) startAt!: string;
  @ApiProperty({ format: 'date-time' }) endAt!: string;
  @ApiProperty() status!: string;
  @ApiPropertyOptional() managementUrl?: string;
}
class TrainerBlockerCountsDto {
  @ApiProperty() BOOKING!: number;
  @ApiProperty() SHIFT!: number;
  @ApiProperty() PUBLIC_SESSION!: number;
}
export class TrainerBlockerPageDto extends TrainerPaginationDto {
  @ApiProperty({ type: [TrainerBlockerDto] }) items!: TrainerBlockerDto[];
  @ApiProperty({ type: TrainerBlockerCountsDto }) counts!: TrainerBlockerCountsDto;
  @ApiProperty({ format: 'date-time' }) asOf!: string;
  @ApiProperty() total!: number;
  @ApiProperty() totalPages!: number;
}
