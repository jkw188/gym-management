// Tầng kiểm tra dữ liệu (EN-03 bước 3): query của GET /api/notifications/sync.
import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export class SyncQueryDto {
  // Cursor opaque do chính server cấp; nội dung được kiểm chữ ký ở service.
  @IsOptional() @IsString() @MaxLength(200)
  cursor?: string;

  // EN-03-TC11: limit là số nguyên 1–100 (query luôn là chuỗi); không truyền thì service dùng 50.
  @IsOptional() @Matches(/^(?:[1-9]\d?|100)$/)
  limit?: string;
}
