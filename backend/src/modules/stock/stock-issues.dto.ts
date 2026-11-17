import { Type } from 'class-transformer';
import { ApiProperty, OmitType } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt, Max, Min, ValidateNested } from 'class-validator';
import { CreateReceiptDto, ReceiptItemDto, ReceiptResponseDto } from './stock-receipts.dto';
export { EmptyStockQueryDto, PostReceiptDto, PostedReceiptResponseDto as PostedIssueResponseDto, ReceiptPageResponseDto, ReceiptQueryDto } from './stock-receipts.dto';

export class IssueItemDto extends OmitType(ReceiptItemDto, ['quantity'] as const) {
  @ApiProperty({ minimum: 1, maximum: 999 }) @IsInt() @Min(1) @Max(999) quantity!: number;
}
export class CreateIssueDto extends OmitType(CreateReceiptDto, ['items'] as const) {
  @ApiProperty({ type: [IssueItemDto], minItems: 1, maxItems: 100 })
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => IssueItemDto) items!: IssueItemDto[];
}
export class UpdateIssueDto extends CreateIssueDto {
  @ApiProperty({ minimum: 0, maximum: 2147483647 }) @IsInt() @Min(0) @Max(2147483647) version!: number;
}
export class IssueAuditResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: ['CREATED', 'UPDATED', 'POSTED'] }) action!: string;
  @ApiProperty() actorId!: string;
  @ApiProperty() occurredAt!: string;
  @ApiProperty({ type: Object, nullable: true }) before!: Record<string, unknown> | null;
  @ApiProperty({ type: Object }) after!: Record<string, unknown>;
}
export class IssueResponseDto extends ReceiptResponseDto {
  @ApiProperty({ type: [IssueAuditResponseDto], required: false }) audit?: IssueAuditResponseDto[];
}
