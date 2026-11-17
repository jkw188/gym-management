import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { ArrayNotEmpty, IsArray, IsIn, IsInt, IsMongoId, IsOptional, IsString, Matches, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';
import { MeListQueryDto } from '../memberships/me-memberships.dto';
import { ROLE_CODES, RoleCode } from '../users/schemas/role.schema';

const trim = ({ value }: { value: unknown }) => typeof value === 'string' && !/[\u0000-\u001f\u007f-\u009f]/u.test(value) ? value.trim() : value;
export class PreviewBroadcastDto {
  @ApiProperty({ enum: ['ALL_ACTIVE', 'ROLES'] }) @IsIn(['ALL_ACTIVE', 'ROLES']) audience!: 'ALL_ACTIVE' | 'ROLES';
  @ApiPropertyOptional({ enum: ROLE_CODES, isArray: true })
  @ValidateIf((input: PreviewBroadcastDto) => input.audience === 'ROLES' || input.roles !== undefined)
  @IsArray() @ArrayNotEmpty() @IsIn(ROLE_CODES, { each: true }) roles?: RoleCode[];
  @ApiProperty({ maxLength: 190 }) @IsString() @Transform(trim) @MinLength(1) @MaxLength(190)
  @Matches(/^[^\u0000-\u001f\u007f-\u009f]*$/u) title!: string;
  @ApiProperty({ maxLength: 2000 }) @IsString() @Transform(trim) @MinLength(1) @MaxLength(2000)
  @Matches(/^[^\u0000-\u001f\u007f-\u009f]*$/u) body!: string;
}
export class SendBroadcastDto {
  @ApiProperty({ minimum: 0 }) @IsInt() @Min(0) version!: number;
}
export class BroadcastParamDto {
  @ApiProperty() @IsMongoId() id!: string;
}
export class EmptyBroadcastQueryDto {}
export class BroadcastQueryDto extends MeListQueryDto {
  @ApiPropertyOptional({ enum: ['PREVIEW', 'SENT'] }) @IsOptional() @IsIn(['PREVIEW', 'SENT']) status?: 'PREVIEW' | 'SENT';
  @ApiPropertyOptional({ format: 'date' }) @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) fromDate?: string;
  @ApiPropertyOptional({ format: 'date' }) @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) toDate?: string;
}
export class BroadcastPreviewResponseDto {
  @ApiProperty() previewId!: string;
  @ApiProperty() version!: number;
  @ApiProperty({ format: 'date-time' }) expiresAt!: string;
  @ApiProperty({ format: 'date-time' }) snapshotAt!: string;
  @ApiProperty() recipientCount!: number;
  @ApiProperty() audienceSummary!: string;
  @ApiProperty() title!: string;
  @ApiProperty() body!: string;
}
export class BroadcastSentResponseDto {
  @ApiProperty() broadcastId!: string;
  @ApiProperty() notificationId!: string;
  @ApiProperty({ enum: ['SENT'] }) status!: 'SENT';
  @ApiProperty() recipientCount!: number;
  @ApiProperty({ enum: ['READY', 'PROCESSING', 'DONE', 'DEAD'] }) dispatchStatus!: string;
}
export class BroadcastDetailResponseDto extends BroadcastPreviewResponseDto {
  @ApiProperty() broadcastId!: string;
  @ApiProperty({ enum: ['PREVIEW', 'SENT'] }) status!: string;
  @ApiPropertyOptional() notificationId?: string;
  @ApiPropertyOptional({ nullable: true }) dispatchStatus!: string | null;
  @ApiProperty({ example: { snapshot: 3, sent: 3, delivered: 1, read: 0 } }) counts!: { snapshot: number; sent: number; delivered: number; read: number };
  @ApiProperty({ format: 'date-time' }) asOf!: string;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiPropertyOptional({ format: 'date-time' }) sentAt?: string;
}
export class BroadcastPageResponseDto {
  @ApiProperty({ type: [BroadcastDetailResponseDto] }) items!: BroadcastDetailResponseDto[];
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
  @ApiProperty() total!: number;
  @ApiProperty() totalPages!: number;
  @ApiProperty({ format: 'date-time' }) asOf!: string;
}
