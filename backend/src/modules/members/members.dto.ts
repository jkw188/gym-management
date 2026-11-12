import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmpty, IsIn, IsInt, IsString, Matches, Max, MaxLength, Min, ValidateIf } from 'class-validator';
import { VERIFICATION_METHODS, VerificationMethod } from './schemas/member-link-event.schema';
import { EntitlementSummaryDto, MemberReadTimeDto } from './members-query.dto';

// Thông báo khi client gửi field do server quản lý.
const SERVER_OWNED = { message: 'Trường do hệ thống quản lý, không được gửi lên' };

const present = (_object: unknown, value: unknown) => value !== undefined;
export class CreateMemberDto {
  @ApiProperty({ minLength: 2, maxLength: 120 }) @IsString() fullName!: string;
  @ApiProperty() @IsString() @MaxLength(32) phone!: string;
  @ApiPropertyOptional({ example: '2000-01-31' }) @ValidateIf(present) @IsString() birthDate?: string;
  @ApiPropertyOptional({ maxLength: 255 }) @ValidateIf(present) @IsString() address?: string;

  // US-09-F02, US-09-TC03: mã, ID, version, tài khoản và trường gói do server quản lý. Khai báo rõ ở đây để
  // client gửi lên thì bị 400 kèm đúng tên field (field lạ khác vẫn bị ValidationPipe toàn cục chặn, báo unknownField).
  @IsEmpty(SERVER_OWNED) id?: never;
  @IsEmpty(SERVER_OWNED) memberCode?: never;
  @IsEmpty(SERVER_OWNED) accountId?: never;
  @IsEmpty(SERVER_OWNED) version?: never;
  @IsEmpty(SERVER_OWNED) planId?: never;
  @IsEmpty(SERVER_OWNED) sessionsQuota?: never;
}
export class LinkCandidatesQueryDto {
  @ApiProperty() @IsString() @MaxLength(32) phone!: string;
}
export class UpdateMemberDto {
  @ApiProperty({ minimum: 0 }) @IsInt() @Min(0) version!: number;
  @ApiPropertyOptional({ minLength: 2, maxLength: 120 }) @ValidateIf(present) @IsString() fullName?: string;
  @ApiPropertyOptional({ maxLength: 32 }) @ValidateIf(present) @IsString() @MaxLength(32) phone?: string;
  @ApiPropertyOptional({ nullable: true, example: '2000-01-31' })
  @ValidateIf((_object, value) => value !== undefined && value !== null) @IsString() birthDate?: string | null;
  @ApiPropertyOptional({ nullable: true, maxLength: 255 })
  @ValidateIf((_object, value) => value !== undefined && value !== null) @IsString() address?: string | null;
}
export class LinkMemberDto {
  @ApiProperty() @Matches(/^[a-f\d]{24}$/i) accountId!: string;
  @ApiProperty({ minimum: 0 }) @IsInt() @Min(0) @Max(2147483646) version!: number;
  @ApiProperty({ enum: VERIFICATION_METHODS }) @IsIn(VERIFICATION_METHODS) verificationMethod!: VerificationMethod;
  @ApiProperty({ minLength: 10, maxLength: 500 }) @IsString() verificationNote!: string;
}
export class MemberDto {
  @ApiProperty() id!: string;
  @ApiProperty() memberCode!: string;
  @ApiProperty() fullName!: string;
  @ApiProperty() phone!: string;
  @ApiPropertyOptional() birthDate?: string;
  @ApiPropertyOptional() address?: string;
  @ApiPropertyOptional() accountId?: string;
  @ApiProperty() version!: number;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}
export class LinkMemberResponseDto {
  @ApiProperty({ type: MemberDto }) member!: MemberDto;
  @ApiProperty({ example: true }) linked!: boolean;
}
export class UpdateMemberResponseDto {
  @ApiProperty({ type: MemberDto }) member!: MemberDto;
  @ApiProperty() changed!: boolean;
}
export class MemberDetailResponseDto extends MemberReadTimeDto {
  @ApiProperty({ type: MemberDto }) member!: MemberDto;
  @ApiProperty({ type: EntitlementSummaryDto }) entitlementSummary!: EntitlementSummaryDto;
}
export class LinkCandidateDto {
  @ApiProperty() id!: string;
  @ApiProperty() fullName!: string;
  @ApiProperty() phone!: string;
  @ApiProperty() canLink!: boolean;
}
export class LinkCandidatesResponseDto {
  @ApiProperty({ type: [LinkCandidateDto] }) items!: LinkCandidateDto[];
}
