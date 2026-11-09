import { ApiProperty, ApiPropertyOptional, PartialType, PickType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsMongoId, IsString, Length, Matches, Max, MaxLength, Min, ValidateIf } from 'class-validator';
import { CATALOG_STATUSES, CatalogStatus, PLAN_KINDS, PlanKind } from './schemas/plan.schema';
import { CONVERSION_RULE } from './schemas/plan-policy.schema';

const present = (_object: unknown, value: unknown) => value !== undefined;
const trim = ({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value;
const integerQuery = ({ value }: { value: unknown }) => typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : value;

export class CatalogPaginationDto {
  @ApiPropertyOptional({ default: 1, minimum: 1 }) @Transform(integerQuery) @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) page = 1;
  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 }) @Transform(integerQuery) @IsInt() @Min(1) @Max(100) limit = 20;
}
export class PlanListQueryDto extends CatalogPaginationDto {
  @ApiPropertyOptional({ maxLength: 120 }) @ValidateIf(present) @IsString() @MaxLength(120) q?: string;
  @ApiPropertyOptional({ enum: PLAN_KINDS }) @ValidateIf(present) @IsIn(PLAN_KINDS) kind?: PlanKind;
  @ApiPropertyOptional({ enum: CATALOG_STATUSES }) @ValidateIf(present) @IsIn(CATALOG_STATUSES) status?: CatalogStatus;
}
export class PolicyListQueryDto extends CatalogPaginationDto {
  @ApiPropertyOptional() @ValidateIf(present) @IsMongoId() fromPlanId?: string;
}
export class EmptyPlanQueryDto {}
export class CreatePlanDto {
  @ApiProperty({ minLength: 3, maxLength: 30, pattern: '^[A-Z0-9_-]{3,30}$', description: 'Trim/uppercase; bất biến sau tạo.' })
  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim().toUpperCase() : value)
  @IsString() @Matches(/^[A-Z0-9_-]{3,30}$/) code!: string;
  @ApiProperty({ minLength: 2, maxLength: 120 }) @Transform(trim) @IsString() @Length(2, 120) name!: string;
  @ApiProperty({ enum: PLAN_KINDS }) @IsIn(PLAN_KINDS) kind!: PlanKind;
  @ApiProperty({ minimum: 1, maximum: 3650 }) @IsInt() @Min(1) @Max(3650) durationDays!: number;
  @ApiProperty({ minimum: 0, maximum: 10000, description: 'GYM = 0; PT = 1–10000.' }) @IsInt() @Min(0) @Max(10000) sessionsQuota!: number;
  @ApiProperty({ type: String, pattern: '^0*\\d{1,12}$', example: '500000', description: 'VND nguyên 0–999999999999; luôn là string; chuẩn hóa bỏ số 0 đầu theo EN-02.' })
  @IsString() @Matches(/^0*\d{1,12}$/) price!: string;
  @ApiProperty({ minLength: 1, maxLength: 1000 }) @Transform(trim) @IsString() @Length(1, 1000) benefits!: string;
}
export class UpdatePlanDto extends PartialType(PickType(CreatePlanDto,
  ['name', 'durationDays', 'sessionsQuota', 'price', 'benefits'] as const), { skipNullProperties: false }) {
  @ApiProperty({ minimum: 0, maximum: 2147483647 }) @IsInt() @Min(0) @Max(2147483647) version!: number;
  @ApiPropertyOptional({ enum: CATALOG_STATUSES }) @ValidateIf(present) @IsIn(CATALOG_STATUSES) status?: CatalogStatus;
}
export class CreatePolicyDto {
  @ApiProperty() @IsMongoId() fromPlanId!: string;
  @ApiProperty() @IsMongoId() toPlanId!: string;
  @ApiProperty({ enum: CATALOG_STATUSES }) @IsIn(CATALOG_STATUSES) status!: CatalogStatus;
  @ApiPropertyOptional({ maxLength: 500 }) @ValidateIf(present) @Transform(trim) @IsString() @MaxLength(500) note?: string;
}
export class UpdatePolicyDto extends PickType(CreatePolicyDto, ['status', 'note'] as const) {
  @ApiProperty({ minimum: 0, maximum: 2147483647 }) @IsInt() @Min(0) @Max(2147483647) version!: number;
}
export class PlanDto extends CreatePlanDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: CATALOG_STATUSES }) status!: CatalogStatus;
  @ApiProperty() version!: number;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}
export class PolicyDto extends CreatePolicyDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: [CONVERSION_RULE] }) ruleCode!: typeof CONVERSION_RULE;
  @ApiProperty() version!: number;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}
export class PlanPageDto extends CatalogPaginationDto {
  @ApiProperty({ type: [PlanDto] }) items!: PlanDto[];
  @ApiProperty() total!: number;
  @ApiProperty() totalPages!: number;
}
export class PolicyPageDto extends CatalogPaginationDto {
  @ApiProperty({ type: [PolicyDto] }) items!: PolicyDto[];
  @ApiProperty() total!: number;
  @ApiProperty() totalPages!: number;
}
export class PlanUpdateResultDto {
  @ApiProperty({ type: PlanDto }) plan!: PlanDto;
  @ApiProperty() changed!: boolean;
}
export class PolicyUpdateResultDto {
  @ApiProperty({ type: PolicyDto }) policy!: PolicyDto;
  @ApiProperty() changed!: boolean;
}
