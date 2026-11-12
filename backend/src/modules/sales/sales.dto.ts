import { Transform } from 'class-transformer';
import { IsInt, IsMongoId, IsString, Length, Matches, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

export class RegisterSaleDto {
  @ApiProperty() @IsMongoId() memberId!: string;
  @ApiProperty() @IsMongoId() planId!: string;
  @ApiProperty({ minimum: 0 }) @IsInt() @Min(0) @Max(Number.MAX_SAFE_INTEGER) planVersion!: number;
  @ApiProperty({ example: '2026-11-11' }) @IsString() @Matches(/^\d{4}-\d{2}-\d{2}$/) startDate!: string;
}
export class CancelSaleDto {
  @ApiProperty({ minimum: 0 }) @IsInt() @Min(0) @Max(Number.MAX_SAFE_INTEGER) version!: number;
  @ApiProperty({ minLength: 10, maxLength: 500 })
  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value)
  @IsString() @Length(10, 500) reason!: string;
}
export class PendingSalesQueryDto {
  @IsMongoId() memberId!: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(100000) page = 1;
}
