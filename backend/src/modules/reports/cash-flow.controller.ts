import { Controller, Get, Header, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiResponse, ApiTags, SchemaObject } from '@nestjs/swagger';
import { ErrorResponseDto } from '../../common/http/error.dto';
import { FixedPermission } from '../users/access.policy';
import { CashFlowEventParamsDto, CashFlowEventsQueryDto, CashFlowQueryDto } from './cash-flow.dto';
import { CashFlowService } from './cash-flow.service';

const object = (properties: Record<string, SchemaObject>): SchemaObject => ({ type: 'object', required: Object.keys(properties), properties });
const text: SchemaObject = { type: 'string', nullable: true };
const timestamp: SchemaObject = { type: 'string', format: 'date-time' };
const money: SchemaObject = { type: 'string', pattern: '^-?\\d+$', nullable: true, description: 'Chuỗi nguyên VND, net có thể âm; null nếu không chắc chắn' };
const totals = object({ grossReceipts: money, refundPaid: money, netCash: money });
const quality: SchemaObject = { type: 'string', enum: ['COMPLETE', 'PARTIAL', 'UNAVAILABLE'] };
const codes: SchemaObject = { type: 'array', items: { type: 'string' } };
const metrics = object({ totals, knownTotals: object({ label: quality, grossReceipts: money, refundPaid: money, netCash: money }) });
const event = object({ eventId: text, id: text, eventType: { type: 'string', enum: ['RECEIPT', 'REFUND'] },
  occurredAt: { ...timestamp, nullable: true }, amount: money, kind: { type: 'string', enum: ['GYM', 'PT', 'RETAIL', 'UNKNOWN'] },
  method: { type: 'string', enum: ['CASH', 'TRANSFER', 'UNKNOWN'] }, status: text, paymentId: text, refundId: text,
  transactionId: text, transactionCode: text, orderId: text, orderCode: text, returnId: text, invoiceId: text, invoiceCode: text,
  lateReceipt: { type: 'boolean' }, warningCodes: codes });
const summary = {
  range: object({ fromDate: text, toDate: text, timezone: text, start: timestamp, endExclusive: timestamp,
    effectiveTo: timestamp, isOngoing: { type: 'boolean' } }),
  observedAt: timestamp, metricVersion: { type: 'string', enum: ['S08-V1'] } as SchemaObject,
  dataQuality: quality, invalidRecordCount: { type: 'integer', minimum: 0 } as SchemaObject, warningCodes: codes,
  ...metrics.properties,
  filter: object({ kind: text, paymentMethod: text, payoutMethod: text, paymentMethodScope: text, payoutMethodScope: text }),
  byKind: object({ GYM: metrics, PT: metrics, RETAIL: metrics, UNKNOWN: metrics }),
  byDate: { type: 'array', items: object({ date: text, isComplete: { type: 'boolean' }, ...metrics.properties }) } as SchemaObject,
  byMethod: object({ receipts: object({ CASH: metrics, TRANSFER: metrics, UNKNOWN: metrics }),
    refunds: object({ CASH: metrics, TRANSFER: metrics, UNKNOWN: metrics }) }),
  currentOutstandingRefunds: object({ scope: text, dateFilterApplied: { type: 'boolean' }, methodFiltersApplied: { type: 'boolean' },
    kind: text, observedAt: timestamp, outstandingRefundAmount: money, count: { type: 'integer', nullable: true },
    knownAmount: money, knownCount: { type: 'integer' }, dataQuality: quality }),
};

@ApiTags('cash-flow-reports') @ApiBearerAuth()
@ApiResponse({ status: 400, type: ErrorResponseDto }) @ApiResponse({ status: 401, type: ErrorResponseDto })
@ApiResponse({ status: 403, type: ErrorResponseDto }) @ApiResponse({ status: 404, type: ErrorResponseDto })
@ApiResponse({ status: 409, type: ErrorResponseDto }) @ApiResponse({ status: 429, type: ErrorResponseDto })
@ApiResponse({ status: 503, type: ErrorResponseDto })
@Controller('reports/cash-flow') @FixedPermission('reports.cashFlow.read')
export class CashFlowController {
  constructor(private readonly reports: CashFlowService) {}
  @Get('summary') @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'US-51 / UC-38 / S08-C01: Thu, đã hoàn, thu trừ hoàn theo dòng tiền', description:
    'Một snapshot primary/request. payments SUCCEEDED theo paid_at, refunds SUCCEEDED theo refunded_at, không lọc transaction SETTLED. Ngày VN bao gồm hai đầu, timestamp <=observedAt. paymentMethod chỉ thu, payoutMethod chỉ đã chi. Nghĩa vụ hiện tại chỉ lọc kind, không phải số dư lịch sử. Tổng tiền nguyên VND chính xác không giới hạn trần một giao dịch; net có dấu. GET không ghi nguồn.' })
  @ApiOkResponse({ schema: object(summary) })
  summary(@Query() query: CashFlowQueryDto) { return this.reports.summary(query); }
  @Get('events') @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'US-51: KPI, nhóm và trang sự kiện cùng snapshot', description:
    'eventType/q/page/limit chỉ lọc bảng; sort occurredAt DESC,eventType ASC,id DESC. Nguồn thiếu timestamp xuất cuối bảng với cảnh báo. Không đọc evidence hoặc bankReference. knownTotals có nhãn PARTIAL khi dữ liệu thiếu.' })
  @ApiOkResponse({ schema: object({ ...summary, eventFilter: object({ eventType: text, q: text }),
    items: { type: 'array', items: event }, page: { type: 'integer' }, limit: { type: 'integer' },
    total: { type: 'integer' }, totalPages: { type: 'integer' } }) })
  events(@Query() query: CashFlowEventsQueryDto) { return this.reports.events(query); }
  @Get('events/:eventType/:id') @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'US-51: đối chiếu một nguồn thu/hoàn; khoản muộn không bắt buộc invoice', description:
    'Request riêng có observedAt riêng. Link chứng từ vẫn yêu cầu quyền nguồn độc lập; không cấp quyền sửa nguồn.' })
  @ApiOkResponse({ schema: object({ ...summary, event }) })
  detail(@Param() params: CashFlowEventParamsDto, @Query() query: CashFlowQueryDto) {
    return this.reports.detail(params.eventType, params.id, query);
  }
}
