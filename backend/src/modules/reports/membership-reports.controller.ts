import { Controller, Get, Header, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiResponse, ApiTags, SchemaObject } from '@nestjs/swagger';
import { ErrorResponseDto } from '../../common/http/error.dto';
import { FixedPermission } from '../users/access.policy';
import { MembershipMembersQueryDto, MembershipReportIdDto, MembershipReportTimeDto, MembershipSummaryQueryDto } from './membership-reports.dto';
import { MembershipReportsService } from './membership-reports.service';

const number: SchemaObject = { type: 'number', nullable: true, minimum: 0 };
const string: SchemaObject = { type: 'string', nullable: true };
const timestamp: SchemaObject = { ...string, format: 'date-time' };
const codes: SchemaObject = { type: 'array', items: { type: 'string' } };
const object = (properties: Record<string, SchemaObject>): SchemaObject => ({ type: 'object', required: Object.keys(properties), properties });
const kind = object({ activeMembers: number, activeMemberships: number });
const summary = {
  asOfAt: timestamp, observedAt: timestamp, metricVersion: { type: 'string', enum: ['S08-V1'] } as SchemaObject,
  dataQuality: { type: 'string', enum: ['COMPLETE', 'PARTIAL', 'UNAVAILABLE'] } as SchemaObject,
  totalMembers: number, activeMembers: number, inactiveMembers: number, activeRate: number, activeMemberships: number,
  byKind: object({ GYM: kind, PT: kind }), invalidRecordCount: { type: 'integer', minimum: 0 } as SchemaObject,
  warningCodes: codes, knownTotals: object({ totalMembers: number, activeMembers: number, activeMemberships: number }),
  filter: { type: 'object', properties: { kind: { type: 'string', enum: ['ALL', 'GYM', 'PT'] },
    activity: { type: 'string' }, q: { type: 'string' } } } as SchemaObject,
};
const member = object({ memberId: string, code: string, displayName: string, linkedAccount: { type: 'boolean' },
  qualifyingMembershipCount: number, activity: { type: 'string', enum: ['ACTIVE', 'INACTIVE', 'UNKNOWN'] } });
const source = object({ membershipId: string, serviceSaleId: string, transactionId: string, kind: string,
  planId: string, planNameSnapshot: string, startDate: string, endDate: string,
  createdAt: timestamp, effectiveStart: timestamp, effectiveEnd: timestamp, currentStatus: string, currentTransactionStatus: string,
  qualifies: { type: 'boolean', nullable: true }, reasonCodes: codes });

@ApiTags('membership-reports') @ApiBearerAuth()
@ApiResponse({ status: 400, type: ErrorResponseDto }) @ApiResponse({ status: 401, type: ErrorResponseDto })
@ApiResponse({ status: 403, type: ErrorResponseDto }) @ApiResponse({ status: 404, type: ErrorResponseDto })
@ApiResponse({ status: 409, type: ErrorResponseDto }) @ApiResponse({ status: 503, type: ErrorResponseDto })
@Controller('reports/memberships') @FixedPermission('reports.memberships.read')
export class MembershipReportsController {
  constructor(private readonly reports: MembershipReportsService) {}
  @Get('summary') @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'US-50 / S08-M01: KPI quyền gói tại timestamp lịch sử', description:
    'Một snapshot primary/request. GYM/PT giữ mẫu số toàn phòng. Không dùng check-in, account status, quota, paid_at hoặc giá plan live. Chỉ số không chắc chắn=null; knownTotals chỉ là phần đã biết. Không đoán historyCoverageFrom khi thiếu chứng cứ.' })
  @ApiOkResponse({ schema: object(summary) })
  summary(@Query() query: MembershipSummaryQueryDto) { return this.reports.summary(query); }

  @Get('members') @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'US-50: bảng distinct hội viên và KPI cùng snapshot', description:
    'activity/q/page chỉ lọc bảng. UNKNOWN nằm trong ALL, không gán thành INACTIVE. Mỗi trang kèm KPI mới và observedAt riêng.' })
  @ApiOkResponse({ schema: object({ ...summary, items: { type: 'array', items: member },
    page: { type: 'integer' }, limit: { type: 'integer' }, total: { type: 'integer' }, totalPages: { type: 'integer' } }) })
  members(@Query() query: MembershipMembersQueryDto) { return this.reports.members(query); }

  @Get('members/:id') @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'US-50: giải thích từng quyền nguồn, trạng thái hiện tại có nhãn riêng' })
  @ApiOkResponse({ schema: object({ ...summary, member, memberships: { type: 'array', items: source } }) })
  detail(@Param() params: MembershipReportIdDto, @Query() query: MembershipReportTimeDto) {
    return this.reports.detail(params.id, query);
  }
}
