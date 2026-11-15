import { ApiProperty, ApiPropertyOptional, OmitType } from '@nestjs/swagger';
import { IsIn, IsString, Matches, MaxLength, ValidateIf } from 'class-validator';
import { ProductOptionsQueryDto, StockPageQueryDto, StockPageResponseDto } from '../stock/stock-receipts.dto';

const optional = (_: unknown, value: unknown) => value !== undefined;
export class InventoryQueryDto extends ProductOptionsQueryDto {
  @ApiPropertyOptional({ enum: ['ACTIVE', 'INACTIVE'] }) @ValidateIf(optional) @IsIn(['ACTIVE', 'INACTIVE']) productStatus?: string;
  @ApiPropertyOptional({ enum: ['IN_STOCK', 'OUT_OF_STOCK', 'ERROR'] }) @ValidateIf(optional) @IsIn(['IN_STOCK', 'OUT_OF_STOCK', 'ERROR']) stockState?: string;
}
// History deliberately excludes q/categoryId: unknown query fields are rejected by the global pipe.
export class MovementQueryDto extends OmitType(StockPageQueryDto, ['q'] as const) {
  @ApiPropertyOptional() @ValidateIf(optional) @IsString() fromDate?: string;
  @ApiPropertyOptional() @ValidateIf(optional) @IsString() toDate?: string;
  @ApiPropertyOptional({ maxLength: 60 }) @ValidateIf(optional) @IsString() @MaxLength(60) @Matches(/^[A-Z][A-Z0-9_]*$/) kind?: string;
}
export class InventoryResponseDto {
  @ApiProperty() productId!: string;
  @ApiProperty() categoryId!: string;
  @ApiProperty() sku!: string;
  @ApiProperty() name!: string;
  @ApiProperty() productStatus!: string;
  @ApiProperty() effectiveActive!: boolean;
  @ApiProperty({ enum: ['VALID', 'MISSING', 'INCONSISTENT'] }) inventoryState!: string;
  @ApiProperty({ type: Number, nullable: true }) onHand!: number | null;
  @ApiProperty({ type: Number, nullable: true }) reserved!: number | null;
  @ApiProperty({ type: Number, nullable: true }) available!: number | null;
  @ApiProperty({ type: Number, nullable: true }) version!: number | null;
  @ApiProperty() asOf!: string;
}
export class InventoryPageResponseDto extends StockPageResponseDto {
  @ApiProperty({ type: [InventoryResponseDto] }) items!: InventoryResponseDto[];
  @ApiProperty() asOf!: string;
}
export class MovementResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() productId!: string;
  @ApiProperty() sequence!: number;
  @ApiProperty() kind!: string;
  @ApiProperty() skuSnapshot!: string;
  @ApiProperty() nameSnapshot!: string;
  @ApiProperty() onHandDelta!: number;
  @ApiProperty() reservedDelta!: number;
  @ApiProperty() beforeOnHand!: number;
  @ApiProperty() beforeReserved!: number;
  @ApiProperty() afterOnHand!: number;
  @ApiProperty() afterReserved!: number;
  @ApiProperty() createdAt!: string;
  @ApiProperty() sourceType!: string;
  @ApiProperty() sourceId!: string;
  @ApiProperty({ type: String, nullable: true }) sourceCode!: string | null;
  @ApiProperty({ type: String, nullable: true }) sourcePath!: string | null;
  @ApiProperty() asOf!: string;
}
export class MovementRangeDto {
  @ApiProperty() fromDate!: string;
  @ApiProperty() toDate!: string;
  @ApiProperty() timeZone!: string;
}
export class MovementPageResponseDto extends StockPageResponseDto {
  @ApiProperty({ type: [MovementResponseDto] }) items!: MovementResponseDto[];
  @ApiProperty() range!: MovementRangeDto;
  @ApiProperty() asOf!: string;
}
