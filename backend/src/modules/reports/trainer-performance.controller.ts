import { Controller, Get, Header, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiResponse, ApiTags, SchemaObject } from '@nestjs/swagger';
import { ErrorResponseDto } from '../../common/http/error.dto';
import { FixedPermission } from '../users/access.policy';
import { TrainerPerformanceDetailDto, TrainerPerformanceIdDto, TrainerPerformanceListDto } from './trainer-performance.dto';
import { TrainerPerformanceService } from './trainer-performance.service';

const object = (properties: Record<string, SchemaObject>): SchemaObject => ({ type: 'object', required: Object.keys(properties), properties });
const text: SchemaObject = { type: 'string', nullable: true };
const count: SchemaObject = { type: 'integer', minimum: 0 };
const uncertainCount: SchemaObject = { ...count, nullable: true };
const at: SchemaObject = { type: 'string', format: 'date-time', nullable: true };
const codes: SchemaObject = { type: 'array', items: { type: 'string' } };
const quality: SchemaObject = { type: 'string', enum: ['COMPLETE', 'PARTIAL', 'UNAVAILABLE'] };
const durations: Record<string, SchemaObject> = {};
for (const name of ['planned', 'completedShift', 'completedBooking', 'knownActual', 'actualTotal', 'knownPlanned', 'knownCompletedBooking'])
  for (const unit of ['Milliseconds', 'Minutes', 'Hours']) durations[`${name}${unit}`] = { type: 'string', nullable: true,
    pattern: unit === 'Milliseconds' ? '^\\d+$' : '^\\d+(\\.\\d{1,4})?$', description: unit === 'Milliseconds' ? 'Milliseconds nguyên chính xác' : 'Chuỗi thập phân tối đa 4 chữ số' };
const metrics = object({ ...durations, shiftCount: uncertainCount, completedShiftCount: uncertainCount, completedBookingCount: uncertainCount, knownCompletedBookingCount: count,
  missingCount: count, openCount: count, closedCount: count, invalidSourceCount: count, overlappingShiftCount: count, overlappingBookingCount: count,
  utilizationRate: { type: 'number', nullable: true }, utilizationStatus: { type: 'string', enum: ['AVAILABLE', 'NOT_APPLICABLE', 'DATA_INCONSISTENT'] },
  reviewCount: uncertainCount, knownReviewCount: count, averageRating: { type: 'number', nullable: true },
  ratingDistribution: { ...object(Object.fromEntries(['1', '2', '3', '4', '5'].map(k => [k, count]))), nullable: true },
  knownRatingDistribution: object(Object.fromEntries(['1', '2', '3', '4', '5'].map(k => [k, count]))),
  dataQuality: quality, knownTotalsLabel: quality, warningCodes: codes, invalidRecordCount: count });
const trainer = { id: text, displayName: text, status: text };
const source = object({ id: text, trainerId: text, shiftId: text, bookingId: text, status: text, startAt: at, endAt: at,
  clippedStartAt: at, clippedEndAt: at, rawMilliseconds: text, clippedMilliseconds: text,
  rawMinutes: text, rawHours: text, clippedMinutes: text, clippedHours: text, completedAt: at, recordedAt: at,
  actorId: text, rating: { type: 'integer', nullable: true }, sourceLink: text, dataIssue: codes });
const page = (item: SchemaObject) => object({ items: { type: 'array', items: item }, page: count, limit: count, total: count, totalPages: count });
const common = { range: object({ fromDate: text, toDate: text, timezone: text, start: at, endExclusive: at, effectiveTo: at, isOngoing: { type: 'boolean' } }),
  observedAt: at, metricVersion: { type: 'string', enum: ['S08-V1'] } as SchemaObject, dataQuality: quality, warningCodes: codes, invalidRecordCount: count };

@ApiTags('trainer-performance-reports') @ApiBearerAuth()
@ApiResponse({ status: 400, type: ErrorResponseDto }) @ApiResponse({ status: 401, type: ErrorResponseDto })
@ApiResponse({ status: 403, type: ErrorResponseDto }) @ApiResponse({ status: 404, type: ErrorResponseDto })
@ApiResponse({ status: 409, type: ErrorResponseDto }) @ApiResponse({ status: 429, type: ErrorResponseDto })
@ApiResponse({ status: 503, type: ErrorResponseDto })
@Controller('reports/trainers') @FixedPermission('reports.trainers.read')
export class TrainerPerformanceController {
  constructor(private readonly reports: TrainerPerformanceService) {}
  @Get('performance') @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'US-52 / UC-38 / S08-P01: hiệu suất PT theo giao kỳ', description:
    'Một snapshot primary/request; trạng thái đã committed tại lúc đọc, không time-travel. Union mỗi PT/mỗi nguồn, sau đó cộng toàn tập. Utilization=100×completedBooking/planned, không trung bình các tỷ lệ. Attendance OPEN/MISSING giữ null. q literal chỉ lọc bảng, trainerId/kỳ lọc cả tổng. GET không ghi nguồn.' })
  @ApiOkResponse({ schema: object({ ...common, ...page(object({ ...trainer, summary: metrics })).properties, totals: metrics,
    filter: object({ trainerId: text, q: text, qScope: text }) }) })
  list(@Query() query: TrainerPerformanceListDto) { return this.reports.list(query); }
  @Get(':id/performance') @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'US-52: tổng và bốn trang nguồn cùng snapshot', description:
    'Raw/clipped interval, completedAt và actor được phép. Link chỉ tới attendance/booking/review theo ID, quyền nguồn được kiểm độc lập. Review theo created_at dù booking ngoài kỳ. Trang sort thời gian nguồn DESC,id DESC. Ca COMPLETED chỉ từ status, không suy từ checkout.' })
  @ApiOkResponse({ schema: object({ ...common, trainer: object(trainer), summary: metrics,
    sourcePages: object({ shifts: page(source), attendance: page(source), bookings: page(source), reviews: page(source) }) }) })
  detail(@Param() params: TrainerPerformanceIdDto, @Query() query: TrainerPerformanceDetailDto) { return this.reports.detail(params.id, query); }
}
