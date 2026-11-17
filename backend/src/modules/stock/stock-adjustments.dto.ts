import { Type } from 'class-transformer';
import { ApiProperty, OmitType } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt, Max, Min, ValidateNested } from 'class-validator';
import { CreateReceiptDto, ReceiptItemDto, ReceiptItemResponseDto, ReceiptResponseDto } from './stock-receipts.dto';
import { IssueAuditResponseDto } from './stock-issues.dto';

export class AdjustmentItemDto extends OmitType(ReceiptItemDto, ['quantity'] as const) {
  @ApiProperty({ minimum: 0, maximum: 2147483647 }) @IsInt() @Min(0) @Max(2147483647) countedQuantity!: number;
  @ApiProperty({ minimum: 0, maximum: 2147483647 }) @IsInt() @Min(0) @Max(2147483647) expectedInventoryVersion!: number;
}
export class CreateAdjustmentDto extends OmitType(CreateReceiptDto, ['items'] as const) {
  @ApiProperty({ type: [AdjustmentItemDto], minItems: 1, maxItems: 100 })
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => AdjustmentItemDto) items!: AdjustmentItemDto[];
}
export class UpdateAdjustmentDto extends CreateAdjustmentDto {
  @ApiProperty({ minimum: 0, maximum: 2147483647 }) @IsInt() @Min(0) @Max(2147483647) version!: number;
}
export class AdjustmentItemResponseDto extends OmitType(ReceiptItemResponseDto, ['quantity'] as const) {
  @ApiProperty() countedQuantity!: number;
  @ApiProperty() baseOnHand!: number;
  @ApiProperty() baseInventoryVersion!: number;
  @ApiProperty() countedAt!: string;
  @ApiProperty() quantityDelta!: number;
  @ApiProperty({ type: Number, nullable: true }) currentOnHand!: number | null;
  @ApiProperty({ type: Number, nullable: true }) currentReserved!: number | null;
  @ApiProperty({ type: Number, nullable: true }) currentInventoryVersion!: number | null;
  @ApiProperty({ enum: ['VALID', 'MISSING', 'INCONSISTENT'] }) inventoryState!: string;
  @ApiProperty() stale!: boolean;
}
export class AdjustmentResponseDto extends OmitType(ReceiptResponseDto, ['items'] as const) {
  @ApiProperty({ type: [AdjustmentItemResponseDto] }) items!: AdjustmentItemResponseDto[];
  @ApiProperty() stale!: boolean;
  @ApiProperty({ type: [IssueAuditResponseDto], required: false }) audit?: IssueAuditResponseDto[];
}
