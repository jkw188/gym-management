import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiResponse, ApiTags, SchemaObject } from '@nestjs/swagger';
import { ErrorResponseDto } from '../../common/http/error.dto';
import { FixedPermission } from '../users/access.policy';
import { ActivityDetailQueryDto, ActivityIdDto, ActivityListQueryDto } from './trainer-activity.dto';
import { TrainerActivityService } from './trainer-activity.service';
import { ACTIVITY_METRICS } from './trainer-activity.types';

const summarySchema = { type: 'object' as const, required: [...ACTIVITY_METRICS], properties:
  Object.fromEntries(ACTIVITY_METRICS.map(key => [key, { type: 'number' as const, minimum: 0 }])) };
const pageProperties = { items: { type: 'array' as const, items: { type: 'object' as const } }, page: { type: 'integer' as const },
  limit: { type: 'integer' as const }, total: { type: 'integer' as const }, totalPages: { type: 'integer' as const }, asOf: { type: 'string' as const, format: 'date-time' } };
const stringValue: SchemaObject = { type: 'string', nullable: true };
const timestamp: SchemaObject = { ...stringValue, format: 'date-time' };
const revision: SchemaObject = { type: 'integer', nullable: true, minimum: 0 };
const dataIssue: SchemaObject = { type: 'array', items: { type: 'string' } };
const object = (properties: Record<string, SchemaObject>): SchemaObject => ({ type: 'object', required: Object.keys(properties), properties });
const rangeSchema = object({ fromDate: { type: 'string', format: 'date' }, toDate: { type: 'string', format: 'date' } });
const trainerSchema = object({ id: { type: 'string' }, displayName: stringValue, status: stringValue, dataIssue, summary: summarySchema });
const attendanceSchema = object({ id: stringValue, state: { type: 'string', enum: ['MISSING', 'OPEN', 'CLOSED'] },
  checkInAt: timestamp, checkOutAt: timestamp,
  actualMinutes: { type: 'number', nullable: true, description: 'Chỉ CLOSED hợp lệ: (out-in)/60000; thiếu/sai dữ liệu=null' },
  recordedBy: stringValue, checkedOutBy: stringValue, version: revision, lastCorrectedBy: stringValue, lastCorrectedAt: timestamp });
const shiftSchema = object({ id: { type: 'string' }, trainerId: stringValue, startAt: timestamp, endAt: timestamp,
  status: stringValue, location: stringValue, dataIssue, attendance: attendanceSchema });
const bookingSchema = object({ id: { type: 'string' }, trainerId: stringValue, memberId: stringValue,
  startAt: timestamp, endAt: timestamp, status: stringValue, completedAt: timestamp, completedBy: stringValue,
  completionRevision: revision, dataIssue });
const pageSchema = (items: SchemaObject): SchemaObject => object({ ...pageProperties, items: { type: 'array', items } });
@ApiTags('trainer-activity') @ApiBearerAuth()
@ApiResponse({ status: 400, type: ErrorResponseDto }) @ApiResponse({ status: 401, type: ErrorResponseDto })
@ApiResponse({ status: 403, type: ErrorResponseDto }) @ApiResponse({ status: 404, type: ErrorResponseDto })
@ApiResponse({ status: 503, type: ErrorResponseDto })
@Controller('admin/trainers') @FixedPermission('trainers.activity.read')
export class TrainerActivityController {
  constructor(private readonly activity: TrainerActivityService) {}
  @Get('activity') @ApiOperation({ summary: 'US-32: đối chiếu PT, tổng toàn tập lọc; chỉ đọc snapshot',
    description: 'Lọc start_at trong ngày VN, tối đa 366 ngày. Chấm công độc lập completion; actualMinutesTotal chỉ cộng CLOSED hợp lệ. PT ngừng hoạt động và nguồn mồ côi vẫn hiện.' })
  @ApiOkResponse({ schema: object({ ...pageSchema(trainerSchema).properties, summary: summarySchema, range: rangeSchema }) })
  list(@Query() query: ActivityListQueryDto) { return this.activity.list(query); }

  @Get(':id/activity') @ApiOperation({ summary: 'US-32: hai trang nguồn độc lập và summary cùng snapshot' })
  @ApiOkResponse({ schema: { type: 'object', properties: { trainer: trainerSchema, range: rangeSchema,
    asOf: pageProperties.asOf, summary: summarySchema,
    shiftsPage: pageSchema(shiftSchema), bookingsPage: pageSchema(bookingSchema) } } })
  detail(@Param() params: ActivityIdDto, @Query() query: ActivityDetailQueryDto) { return this.activity.detail(params.id, query); }
}
