import { Injectable } from '@nestjs/common';
import { ClientSession } from 'mongodb';
import { Types } from 'mongoose';
import { ApplicationError } from '../../common/errors/application-error';
import { ServerClock } from '../../common/utils/business-date';
import { DataGuardsService } from '../../infrastructure/transaction/data-guards.service';
import { TransactionRunner } from '../../infrastructure/transaction/transaction-runner';
import { IdempotencyService, transactionRequestKey } from '../operations/idempotency.service';
import { ShiftIntervalService } from '../shifts/shift-interval.service';
import { activityShift } from '../trainers/trainer-activity.mapper';
import { TrainerActivityService } from '../trainers/trainer-activity.service';
import { AttendanceCheckoutDto, AttendanceCorrectionDto, AttendanceListDto, AttendanceNoteDto } from './attendance.dto';
import { AttendanceRepository } from './attendance.repository';
import { AttendanceRecord } from './attendance.schema';

type Command = 'ATTENDANCE_CHECK_IN' | 'ATTENDANCE_CHECK_OUT' | 'ATTENDANCE_CORRECT';
const conflict = () => new ApplicationError(409, 'VERSION_CONFLICT', 'Chấm công đã thay đổi. Vui lòng tải lại');
function instant(value: string): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new ApplicationError(400, 'VALIDATION_ERROR', 'Thời điểm không hợp lệ');
  return date;
}
const snapshot = (r: AttendanceRecord) => ({ check_in_at: r.check_in_at, check_out_at: r.check_out_at ?? null,
  version: r.version, note: r.note ?? null, recorded_by: r.recorded_by, checked_out_by: r.checked_out_by ?? null });

export function attendanceResponse(r: AttendanceRecord) {
  return { id: String(r._id), shiftId: String(r.shift_id), trainerId: String(r.trainer_id),
    state: r.check_out_at ? 'CLOSED' : 'OPEN', checkInAt: r.check_in_at.toISOString(), checkOutAt: r.check_out_at?.toISOString() ?? null,
    recordedBy: String(r.recorded_by), checkedOutBy: r.checked_out_by ? String(r.checked_out_by) : null,
    version: r.version, note: r.note ?? null, createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(),
    lastCorrectedBy: r.last_corrected_by ? String(r.last_corrected_by) : null, lastCorrectedAt: r.last_corrected_at?.toISOString() ?? null };
}

@Injectable()
export class AttendanceService {
  constructor(private readonly repository: AttendanceRepository, private readonly guards: DataGuardsService,
    private readonly idempotency: IdempotencyService, private readonly clock: ServerClock,
    private readonly transactions: TransactionRunner, private readonly interval: ShiftIntervalService,
    private readonly activity: TrainerActivityService) {}

  detail(id: string, admin: boolean) { return this.activity.attendance(id, admin); }
  list(query: AttendanceListDto) {
    const range = this.interval.vietnamDateRange(query.fromDate, query.toDate, this.clock.now());
    if (!Number.isSafeInteger(query.page * query.limit)) throw new ApplicationError(400, 'VALIDATION_ERROR', 'Trang không hợp lệ');
    return this.transactions.run(async session => {
      const result = await this.repository.list({ start_at: { $gte: range.from, $lt: range.to },
        ...(query.trainerId ? { trainer_id: new Types.ObjectId(query.trainerId) } : {}), ...(query.status ? { status: query.status } : {}),
      }, query.page, query.limit, session);
      return { items: result.items.map(activityShift), trainers: result.trainers.map(t => ({ id: String(t._id), displayName: t.displayName ?? null })),
        page: query.page, limit: query.limit, total: result.total, totalPages: Math.ceil(result.total / query.limit), asOf: this.clock.now().toISOString() };
    });
  }
  checkIn(actor: string, id: string, dto: AttendanceNoteDto, key: string) { return this.write('ATTENDANCE_CHECK_IN', actor, id, dto, key); }
  checkOut(actor: string, id: string, dto: AttendanceCheckoutDto, key: string) { return this.write('ATTENDANCE_CHECK_OUT', actor, id, dto, key); }
  correct(actor: string, id: string, dto: AttendanceCorrectionDto, key: string) { return this.write('ATTENDANCE_CORRECT', actor, id, dto, key); }

  private write(operation: Command, actor: string, id: string, dto: AttendanceNoteDto | AttendanceCheckoutDto | AttendanceCorrectionDto, key: string) {
    const shiftId = new Types.ObjectId(id), actorId = new Types.ObjectId(actor);
    const correction = operation === 'ATTENDANCE_CORRECT' ? dto as AttendanceCorrectionDto : undefined;
    const payload = { ...dto, ...(dto.note !== undefined ? { note: dto.note.trim() } : {}),
      ...(correction ? { checkInAt: instant(correction.checkInAt), checkOutAt: correction.checkOutAt ? instant(correction.checkOutAt) : undefined, reason: correction.reason.trim() } : {}) };
    return this.idempotency.execute({ actorId: actor, operation, clientKey: key, targetId: String(shiftId), payload }, async session => {
      await this.guards.acquire(session, { schedule: true });
      const shift = await this.requireShift(shiftId, session);
      const now = this.clock.now(); // Read again on every transaction retry, after acquiring the schedule guard.
      const current = await this.repository.find(shiftId, session);
      if (current && (!(current.trainer_id instanceof Types.ObjectId) || !current.trainer_id.equals(shift.trainer_id) ||
        !Number.isSafeInteger(current.version) || current.version < 0 || current.version >= Number.MAX_SAFE_INTEGER ||
        !(current.check_in_at instanceof Date) || !Number.isFinite(current.check_in_at.getTime()) ||
        !(current.created_at instanceof Date) || !(current.updated_at instanceof Date))) {
        throw new ApplicationError(409, 'ATTENDANCE_DATA_INVALID', 'Cần đối chiếu và migration dữ liệu chấm công');
      }
      let record: AttendanceRecord;
      const fresh = (checkIn: Date): AttendanceRecord => {
        const _id = new Types.ObjectId();
        return { _id, id: _id, shift_id: shiftId, trainer_id: shift.trainer_id, check_in_at: checkIn,
          recorded_by: actorId, version: 0, created_at: now, updated_at: now,
          ...(dto.note !== undefined ? { note: dto.note.trim() } : {}) };
      };
      if (operation === 'ATTENDANCE_CHECK_IN') {
        if (current) throw new ApplicationError(409, 'ATTENDANCE_ALREADY_EXISTS', 'Ca đã có chấm công');
        if (now >= shift.end_at) throw new ApplicationError(409, 'SHIFT_NOT_ELIGIBLE', 'Ca đã hết giờ. Nhờ Admin bổ sung chấm công bỏ sót');
        record = await this.repository.insert(fresh(now), session);
      } else if (operation === 'ATTENDANCE_CHECK_OUT') {
        if (!current) throw new ApplicationError(409, 'ATTENDANCE_MISSING', 'Ca chưa ghi vào');
        if (current.check_out_at) throw new ApplicationError(409, 'ATTENDANCE_ALREADY_CLOSED', 'Ca đã ghi ra');
        if (current.version !== (dto as AttendanceCheckoutDto).version) throw conflict();
        if (now <= current.check_in_at) throw new ApplicationError(409, 'ATTENDANCE_TIME_INVALID', 'Giờ ra phải sau giờ vào');
        const updated = await this.repository.update(current, { check_out_at: now, checked_out_by: actorId, updated_at: now,
          ...(dto.note !== undefined ? { note: dto.note.trim() } : {}) }, false, session);
        if (!updated) throw conflict();
        record = updated;
      } else {
        const input = correction!;
        const checkIn = new Date(input.checkInAt), checkOut = input.checkOutAt ? new Date(input.checkOutAt) : undefined;
        if (checkIn > now || checkOut && (checkOut > now || checkOut <= checkIn)) {
          throw new ApplicationError(409, 'ATTENDANCE_TIME_INVALID', 'Giờ sửa phải trong quá khứ; giờ ra phải sau giờ vào');
        }
        if (current ? input.version !== current.version : input.version !== undefined) throw conflict();
        if (!current && shift.start_at > now) throw new ApplicationError(409, 'SHIFT_NOT_ELIGIBLE', 'Chỉ bổ sung công bỏ sót cho ca đã diễn ra');
        const change = { check_in_at: checkIn, ...(checkOut ? { check_out_at: checkOut, checked_out_by: actorId } : {}),
          last_corrected_by: actorId, last_corrected_at: now, updated_at: now, ...(dto.note !== undefined ? { note: dto.note.trim() } : {}) };
        if (current) {
          const updated = await this.repository.update(current, change, !checkOut, session);
          if (!updated) throw conflict();
          record = updated;
        } else record = await this.repository.insert({ ...fresh(checkIn), ...change }, session);
      }
      await this.repository.event({ shift_id: shiftId, attendance_id: record._id,
        action: operation === 'ATTENDANCE_CHECK_IN' ? 'CHECK_IN' : operation === 'ATTENDANCE_CHECK_OUT' ? 'CHECK_OUT' : 'CORRECT',
        actor_id: actorId, occurred_at: now, before: current ? snapshot(current) : null, after: snapshot(record),
        ...(correction ? { reason: correction.reason.trim() } : {}), operation_id: transactionRequestKey(actor, operation, key),
      }, session);
      return { status: current ? 200 : 201, body: attendanceResponse(record), resultIds: { attendanceId: record._id, shiftId } };
    });
  }
  private async requireShift(id: Types.ObjectId, session: ClientSession) {
    const shift = await this.repository.shift(id, session);
    if (!shift || !await this.repository.trainer(shift.trainer_id, session)) throw new ApplicationError(404, 'SHIFT_NOT_FOUND', 'Không tìm thấy ca hoặc hồ sơ PT');
    if (!['CONFIRMED', 'COMPLETED'].includes(shift.status)) throw new ApplicationError(409, 'SHIFT_NOT_ELIGIBLE', 'Chỉ chấm công ca CONFIRMED hoặc COMPLETED');
    return shift;
  }
}
