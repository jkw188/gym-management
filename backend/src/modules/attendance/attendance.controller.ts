import { Body, Controller, Get, Param, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiResponse, ApiTags, SchemaObject } from '@nestjs/swagger';
import { Response } from 'express';
import { IdempotencyKey } from '../../common/decorators/idempotency-key.decorator';
import { ErrorResponseDto } from '../../common/http/error.dto';
import { CurrentUser } from '../auth/auth.decorators';
import { AuthPrincipal } from '../auth/auth.types';
import { FixedPermission } from '../users/access.policy';
import { AttendanceCheckoutDto, AttendanceCorrectionDto, AttendanceIdDto, AttendanceListDto, AttendanceNoteDto, EmptyAttendanceQueryDto } from './attendance.dto';
import { AttendanceService } from './attendance.service';

const nullableTime: SchemaObject = { type: 'string', format: 'date-time', nullable: true };
const object = (properties: Record<string, SchemaObject>): SchemaObject => ({ type: 'object', required: Object.keys(properties), properties });
const recordSchema = object({
  id: { type: 'string' }, shiftId: { type: 'string' }, trainerId: { type: 'string' },
  state: { type: 'string', enum: ['OPEN', 'CLOSED'] }, checkInAt: { type: 'string', format: 'date-time' }, checkOutAt: nullableTime,
  recordedBy: { type: 'string' }, checkedOutBy: { type: 'string', nullable: true }, version: { type: 'integer', minimum: 0 },
  note: { type: 'string', nullable: true, maxLength: 255 }, createdAt: { type: 'string', format: 'date-time' },
  updatedAt: { type: 'string', format: 'date-time' }, lastCorrectedBy: { type: 'string', nullable: true }, lastCorrectedAt: nullableTime,
});
const attendanceSchema = object({
  id: { type: 'string', nullable: true }, state: { type: 'string', enum: ['MISSING', 'OPEN', 'CLOSED'] },
  checkInAt: nullableTime, checkOutAt: nullableTime, actualMinutes: { type: 'number', nullable: true },
  recordedBy: { type: 'string', nullable: true }, checkedOutBy: { type: 'string', nullable: true },
  version: { type: 'integer', nullable: true }, lastCorrectedBy: { type: 'string', nullable: true }, lastCorrectedAt: nullableTime,
});
const shiftSchema = object({ id: { type: 'string' }, trainerId: { type: 'string', nullable: true },
  startAt: nullableTime, endAt: nullableTime, status: { type: 'string', nullable: true }, location: { type: 'string', nullable: true },
  dataIssue: { type: 'array', items: { type: 'string' } }, attendance: attendanceSchema });
const eventSnapshot: SchemaObject = { ...object({ checkInAt: nullableTime, checkOutAt: nullableTime,
  version: { type: 'integer', nullable: true } }), nullable: true };
const detailSchema: SchemaObject = {
  ...object({ asOf: { type: 'string', format: 'date-time' }, state: { type: 'string', enum: ['MISSING', 'OPEN', 'CLOSED'] }, shift: shiftSchema,
    note: { type: 'string', nullable: true, maxLength: 255 },
    events: { type: 'array', description: 'Chỉ có cho ADMIN', items: object({ id: { type: 'string', nullable: true },
      attendanceId: { type: 'string', nullable: true }, action: { type: 'string', enum: ['CHECK_IN', 'CHECK_OUT', 'CORRECT'] },
      actorId: { type: 'string', nullable: true }, occurredAt: nullableTime, reason: { type: 'string', nullable: true },
      before: eventSnapshot, after: eventSnapshot }) },
  }), required: ['asOf', 'state', 'shift', 'note'],
};

@ApiTags('trainer-attendance') @ApiBearerAuth()
@ApiResponse({ status: 400, type: ErrorResponseDto }) @ApiResponse({ status: 401, type: ErrorResponseDto })
@ApiResponse({ status: 403, type: ErrorResponseDto }) @ApiResponse({ status: 404, type: ErrorResponseDto })
@ApiResponse({ status: 409, type: ErrorResponseDto }) @ApiResponse({ status: 503, type: ErrorResponseDto })
@Controller('work-shifts')
export class AttendanceController {
  constructor(private readonly attendance: AttendanceService) {}
  @Get() @FixedPermission('attendance.read')
  @ApiOperation({ summary: 'US-63: chọn ngày/PT/ca để chấm công; khoảng tối đa 31 ngày, không gồm dữ liệu booking' })
  @ApiResponse({ status: 200, schema: object({ items: { type: 'array', items: shiftSchema },
    trainers: { type: 'array', items: object({ id: { type: 'string' }, displayName: { type: 'string', nullable: true } }) },
    page: { type: 'integer' }, limit: { type: 'integer' }, total: { type: 'integer' }, totalPages: { type: 'integer' },
    asOf: { type: 'string', format: 'date-time' } }) })
  list(@Query() query: AttendanceListDto) { return this.attendance.list(query); }

  @Get(':id/attendance') @FixedPermission('attendance.read')
  @ApiOperation({ summary: 'US-63: MISSING/OPEN/CLOSED và nguồn ca; chỉ Admin được xem audit' })
  @ApiResponse({ status: 200, schema: detailSchema })
  detail(@CurrentUser() user: AuthPrincipal, @Param() params: AttendanceIdDto, @Query() _query: EmptyAttendanceQueryDto) {
    return this.attendance.detail(params.id, user.roleCode === 'ADMIN');
  }
  @Post(':id/attendance/check-in') @FixedPermission('attendance.record')
  @ApiHeader({ name: 'Idempotency-Key', required: true, description: 'UUID v4, ATTENDANCE_CHECK_IN; replay giữ HTTP/body gốc' })
  @ApiOperation({ summary: 'Ghi vào bằng giờ server, cho đến sớm, phải trước giờ kết thúc ca' })
  @ApiResponse({ status: 201, description: 'Attendance OPEN, version=0, ca/PT, giờ vào và người ghi', schema: recordSchema })
  async checkIn(@CurrentUser() user: AuthPrincipal, @Param() params: AttendanceIdDto, @Body() dto: AttendanceNoteDto,
    @IdempotencyKey() key: string, @Res({ passthrough: true }) response: Response) {
    const result = await this.attendance.checkIn(user.id, params.id, dto, key);
    response.status(result.status); return result.body;
  }
  @Post(':id/attendance/check-out') @FixedPermission('attendance.record')
  @ApiHeader({ name: 'Idempotency-Key', required: true, description: 'UUID v4, ATTENDANCE_CHECK_OUT' })
  @ApiOperation({ summary: 'Ghi ra bằng giờ server với version hiện tại, cho phép ra trễ, không hoàn tất ca/booking' })
  @ApiResponse({ status: 200, description: 'Attendance CLOSED, giờ ra thực tế, version+1', schema: recordSchema })
  async checkOut(@CurrentUser() user: AuthPrincipal, @Param() params: AttendanceIdDto, @Body() dto: AttendanceCheckoutDto,
    @IdempotencyKey() key: string, @Res({ passthrough: true }) response: Response) {
    const result = await this.attendance.checkOut(user.id, params.id, dto, key);
    response.status(result.status); return result.body;
  }
  @Post(':id/attendance/corrections') @FixedPermission('attendance.correct')
  @ApiHeader({ name: 'Idempotency-Key', required: true, description: 'UUID v4, ATTENDANCE_CORRECT' })
  @ApiOperation({ summary: 'Admin sửa sai hoặc bổ sung công bỏ sót; reason 10–500, timestamp có timezone; audit append-only',
    description: 'Bản ghi hiện có bắt buộc version. Bổ sung mới phải bỏ version. Bỏ checkOutAt sẽ mở lại bản ghi.' })
  @ApiResponse({ status: 200, description: 'Đã sửa với version+1 và audit before/after', schema: recordSchema })
  @ApiResponse({ status: 201, description: 'Đã bổ sung chấm công bỏ sót, version=0', schema: recordSchema })
  async correct(@CurrentUser() user: AuthPrincipal, @Param() params: AttendanceIdDto, @Body() dto: AttendanceCorrectionDto,
    @IdempotencyKey() key: string, @Res({ passthrough: true }) response: Response) {
    const result = await this.attendance.correct(user.id, params.id, dto, key);
    response.status(result.status); return result.body;
  }
}
