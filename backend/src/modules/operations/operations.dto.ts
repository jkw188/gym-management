// Tầng kiểm tra dữ liệu (EN-02 bước 3): tham số đường dẫn của GET /api/operations/:operation/:key.
import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsUUID } from 'class-validator';
import { Transform } from 'class-transformer';
import { Operation, OPERATIONS } from './schemas/operation-request.schema';

export class OperationLookupParamsDto {
  @ApiProperty({ enum: OPERATIONS })
  @IsIn(OPERATIONS)
  operation!: Operation;

  // Idempotency-Key là UUID v4 do client tạo (EN-02-D01).
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.toLowerCase() : value)
  key!: string;
}

export class OperationLookupResponseDto {
  @ApiProperty({ enum: ['COMMITTED'] }) status!: 'COMMITTED';
  @ApiProperty() responseStatus!: number;
  @ApiProperty({ type: Object }) responseBody!: Record<string, unknown>;
}
