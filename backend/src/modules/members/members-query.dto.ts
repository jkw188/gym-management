import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsString, Max, MaxLength, Min, ValidateIf } from 'class-validator';

export const SERVICE_KINDS = ['GYM', 'PT'] as const;
export type ServiceKind = typeof SERVICE_KINDS[number];
export const MEMBERSHIP_STATES = ['CURRENT', 'SCHEDULED', 'EXPIRED', 'NONE'] as const;
export type MembershipState = typeof MEMBERSHIP_STATES[number];
const present = (_object: unknown, value: unknown) => value !== undefined;
const integer = ({ value }: { value: unknown }) => typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : value;

export class MemberPaginationDto {
  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @Transform(integer) @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) page = 1;
  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @Transform(integer) @IsInt() @Min(1) @Max(100) limit = 20;
}
export class MembersQueryDto extends MemberPaginationDto {
  @ApiPropertyOptional({ maxLength: 120 }) @ValidateIf(present) @IsString() @MaxLength(120) q?: string;
  @ApiPropertyOptional({ enum: SERVICE_KINDS }) @ValidateIf(present) @IsIn(SERVICE_KINDS) kind?: ServiceKind;
  @ApiPropertyOptional({ enum: MEMBERSHIP_STATES }) @ValidateIf(present) @IsIn(MEMBERSHIP_STATES) membershipState?: MembershipState;
}
export class MemberDetailQueryDto {}
export class EntitlementSummaryDto {
  @ApiProperty({ enum: MEMBERSHIP_STATES, isArray: true }) GYM!: MembershipState[];
  @ApiProperty({ enum: MEMBERSHIP_STATES, isArray: true }) PT!: MembershipState[];
}
export class MemberReadTimeDto {
  @ApiProperty({ format: 'date-time' }) asOf!: string;
  @ApiProperty({ example: '2026-11-09', description: 'Ngày Việt Nam dùng tính trạng thái; cùng thời điểm asOf.' }) businessDate!: string;
}
export class MemberListItemDto {
  @ApiProperty() id!: string;
  @ApiProperty() memberCode!: string;
  @ApiProperty() fullName!: string;
  @ApiProperty() phone!: string;
  @ApiProperty() accountLinked!: boolean;
  @ApiProperty({ type: EntitlementSummaryDto }) entitlementSummary!: EntitlementSummaryDto;
}
export class MemberPageDto extends MemberReadTimeDto {
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
  @ApiProperty() total!: number;
  @ApiProperty() totalPages!: number;
}
export class MemberListResponseDto extends MemberPageDto {
  @ApiProperty({ type: [MemberListItemDto] }) items!: MemberListItemDto[];
}
export class MemberMembershipDto {
  @ApiProperty() membershipId!: string;
  @ApiProperty() saleId!: string;
  @ApiProperty({ enum: SERVICE_KINDS }) kind!: ServiceKind;
  @ApiProperty() planName!: string;
  @ApiProperty({ format: 'date' }) startDate!: string;
  @ApiProperty({ format: 'date' }) endDate!: string;
  @ApiProperty({ enum: ['ACTIVE', 'SUPERSEDED', 'CANCELLED'] }) storedStatus!: string;
  @ApiProperty({ enum: MEMBERSHIP_STATES, description: 'NONE nếu không ACTIVE hoặc giao dịch chưa SETTLED.' }) timeState!: MembershipState;
  @ApiProperty() sessionsQuota!: number;
  @ApiProperty() sessionsUsed!: number;
  @ApiProperty({ enum: ['PENDING', 'SETTLED', 'CANCELLED'] }) transactionStatus!: string;
}
export class MemberMembershipPageDto extends MemberPageDto {
  @ApiProperty({ type: [MemberMembershipDto] }) items!: MemberMembershipDto[];
}
export class MemberTransactionDto {
  @ApiProperty() id!: string;
  @ApiProperty() code!: string;
  @ApiProperty({ enum: ['GYM', 'PT', 'RETAIL'] }) kind!: string;
  @ApiProperty({ enum: ['PENDING', 'SETTLED', 'CANCELLED'] }) status!: string;
  @ApiProperty({ type: String, example: '500000' }) amountDue!: string;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiPropertyOptional({ description: 'Payment SUCCEEDED đã có, chỉ khi transaction SETTLED.' }) paymentId?: string;
  @ApiPropertyOptional() invoiceId?: string;
}
export class MemberTransactionPageDto extends MemberPageDto {
  @ApiProperty({ type: [MemberTransactionDto] }) items!: MemberTransactionDto[];
}
