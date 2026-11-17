// Tầng kiểm tra dữ liệu (EN-03 bước 3): query của GET /api/notifications/sync.
import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class NotificationSourceDto {
  @ApiProperty({ enum: ['MEMBERSHIP', 'PT_BOOKING'] }) type!: 'MEMBERSHIP' | 'PT_BOOKING';
  @ApiProperty({ pattern: '^[a-f0-9]{24}$' }) id!: string;
  @ApiProperty({ format: 'date-time', description: 'Ảnh chụp mốc nhắc, không phải trạng thái hiện tại của nguồn' }) dueAt!: string;
}
export class NotificationDetailDto {
  @ApiProperty() id!: string;
  @ApiProperty() title!: string;
  @ApiProperty() body!: string;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiPropertyOptional({ format: 'date-time' }) readAt?: string;
  @ApiPropertyOptional({ format: 'date-time' }) deliveredAt?: string;
  @ApiPropertyOptional({ type: NotificationSourceDto }) source?: NotificationSourceDto;
}
export class NotificationSyncItemDto {
  @ApiProperty() id!: string;
  @ApiProperty() eventKey!: string;
  @ApiProperty() title!: string;
  @ApiProperty() body!: string;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ description: 'Int64 dưới dạng chuỗi số nguyên' }) sequence!: string;
  @ApiPropertyOptional({ type: NotificationSourceDto }) source?: NotificationSourceDto;
}
export class NotificationSyncDto {
  @ApiProperty({ type: [NotificationSyncItemDto] }) items!: NotificationSyncItemDto[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
  @ApiProperty() hasMore!: boolean;
}

export class SyncQueryDto {
  // Cursor opaque do chính server cấp; nội dung được kiểm chữ ký ở service.
  @IsOptional() @IsString() @MaxLength(200)
  cursor?: string;

  // EN-03-TC11: limit là số nguyên 1–100 (query luôn là chuỗi); không truyền thì service dùng 50.
  @IsOptional() @Matches(/^(?:[1-9]\d?|100)$/)
  limit?: string;
}
