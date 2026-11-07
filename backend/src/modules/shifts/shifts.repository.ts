// Tầng dữ liệu (US-24 bước 2, US-25 bước 2): nơi duy nhất đọc/ghi work_shifts, shift_events, schedule_guards
// và đọc hồ sơ PT (trainers), lịch đặt PT (pt_bookings) phục vụ ca. Lệnh trong transaction nhận session rõ ràng.
import { Injectable } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ClientSession, Long } from 'mongodb';
import { Connection, Model, Types } from 'mongoose';
import { ShiftEvent, ShiftSnapshot } from './schemas/shift-event.schema';
import { WorkShift } from './schemas/work-shift.schema';
import { DateRange, ShiftAction, ShiftStatus, ValidDraft } from './shifts.types';

// Hồ sơ PT theo mục 4.2.8. US-23 (của bạn cùng nhóm) sở hữu collection này; ở đây chỉ đọc.
export interface TrainerProfile {
  _id: Types.ObjectId;
  account_id: Types.ObjectId;
  status: 'ACTIVE' | 'INACTIVE';
}

// Trạng thái ca còn hiệu lực, dùng để kiểm chồng ca; CANCELLED không chặn (US-24-F03).
const BLOCKING_STATUSES: ShiftStatus[] = ['SCHEDULED', 'CONFIRMED', 'COMPLETED'];

export interface NewShiftEvent {
  shiftId: Types.ObjectId;
  actorId: Types.ObjectId;
  action: ShiftAction;
  before?: ShiftSnapshot;
  after: ShiftSnapshot;
  // US-25: lý do khi action CANCELLED.
  reason?: string;
  occurredAt: Date;
  requestKey: string;
}

// US-25: giá trị ghi khi công bố ca (lấy từ ShiftTransitionService.planConfirm).
export interface ConfirmChange {
  version: number;
  confirmedAt: Date;
  updatedAt: Date;
}

// US-25: giá trị ghi khi hủy ca (lấy từ ShiftTransitionService.planCancel).
export interface CancelChange {
  version: number;
  cancelledAt: Date;
  cancellationReason: string;
  updatedAt: Date;
}

@Injectable()
export class ShiftsRepository {
  constructor(
    @InjectModel('WorkShift') private readonly shifts: Model<WorkShift>,
    @InjectModel('ShiftEvent') private readonly events: Model<ShiftEvent>,
    @InjectConnection() private readonly connection: Connection,
  ) {}

  // S04-G01 (hợp đồng của US-28): ghi tăng thật schedule_guards {_id:"global"} TRƯỚC khi kiểm xung đột.
  // Hai transaction cùng ghi một document thì transaction sau bị WriteConflict và driver chạy lại nó
  // sau khi transaction trước commit, nên lần chạy lại thấy ca vừa tạo (US-24-TC09, không write skew).
  async bumpScheduleGuard(session: ClientSession): Promise<void> {
    await this.connection.db!.collection<{ _id: string; revision: Long }>('schedule_guards').updateOne(
      { _id: 'global' },
      { $inc: { revision: Long.fromNumber(1) } },
      // upsert: chưa có guard thì tạo với revision = 1.
      { upsert: true, session },
    );
  }

  // Lookup owner từ account_id của principal (US-24-F01).
  findTrainerByAccount(accountId: Types.ObjectId, session?: ClientSession): Promise<TrainerProfile | null> {
    return this.connection.db!.collection<TrainerProfile>('trainers').findOne({ account_id: accountId }, { session });
  }

  // Chỉ tìm trong ca của chính PT: ca của PT khác coi như không tồn tại (404).
  findOwnShift(shiftId: Types.ObjectId, trainerId: Types.ObjectId, session?: ClientSession): Promise<WorkShift | null> {
    return this.shifts.findOne({ _id: shiftId, trainer_id: trainerId }).session(session ?? null).lean().exec();
  }

  // US-24-TC05, US-24-TC06: có ca còn hiệu lực nào của cùng PT giao [startAt, endAt) không; loại chính id đang sửa.
  // Giao nhau khi ca.start < endAt và startAt < ca.end; hai ca liền nhau không tính.
  async hasOverlap(trainerId: Types.ObjectId, interval: ValidDraft, excludeId: Types.ObjectId | null, session: ClientSession): Promise<boolean> {
    const filter: Record<string, unknown> = {
      trainer_id: trainerId,
      status: { $in: BLOCKING_STATUSES },
      start_at: { $lt: interval.endAt },
      end_at: { $gt: interval.startAt },
    };
    if (excludeId) filter._id = { $ne: excludeId };
    return (await this.shifts.exists(filter).session(session)) !== null;
  }

  // US-24-TC07: ca nháp có lịch đặt BOOKED tham chiếu là dữ liệu bất thường. pt_bookings thuộc US-28; ở đây chỉ đếm.
  async hasBookedReferences(shiftId: Types.ObjectId, session: ClientSession): Promise<boolean> {
    return (await this.countBookedReferences(shiftId, session)) > 0;
  }

  // US-25-TC05: đếm MỌI booking BOOKED tham chiếu ca, không lọc theo giờ (booking giờ bất thường vẫn chặn hủy).
  // Không truyền session khi GET chi tiết ca (chỉ là ảnh chụp cho UI).
  countBookedReferences(shiftId: Types.ObjectId, session?: ClientSession): Promise<number> {
    return this.connection.db!.collection('pt_bookings').countDocuments({ shift_id: shiftId, status: 'BOOKED' }, { session });
  }

  // US-25-TC01, US-25-TC10: CAS – chỉ ghi khi ca vẫn SCHEDULED và đúng version đã đọc; null nếu đã có người ghi trước.
  // timestamps: false để updated_at lấy đúng giờ server mà service đã dùng khi kiểm luật.
  confirmShift(shiftId: Types.ObjectId, expectedVersion: number, change: ConfirmChange, actorId: Types.ObjectId, session: ClientSession): Promise<WorkShift | null> {
    return this.shifts.findOneAndUpdate(
      { _id: shiftId, status: 'SCHEDULED', version: expectedVersion },
      { $set: { status: 'CONFIRMED', version: change.version, confirmed_at: change.confirmedAt, updated_at: change.updatedAt, updated_by: actorId } },
      { session, returnDocument: 'after', timestamps: false },
    ).lean().exec();
  }

  // US-25-TC04, US-25-TC10: CAS – chỉ ghi khi ca vẫn SCHEDULED/CONFIRMED và đúng version; null nếu đã có người ghi trước.
  // Không đụng tới pt_bookings: booking lịch sử giữ nguyên liên kết ca (US-25-TC08).
  cancelShift(shiftId: Types.ObjectId, expectedVersion: number, change: CancelChange, actorId: Types.ObjectId, session: ClientSession): Promise<WorkShift | null> {
    return this.shifts.findOneAndUpdate(
      { _id: shiftId, status: { $in: ['SCHEDULED', 'CONFIRMED'] }, version: expectedVersion },
      { $set: {
        status: 'CANCELLED', version: change.version, cancelled_at: change.cancelledAt, cancelled_by: actorId,
        cancellation_reason: change.cancellationReason, updated_at: change.updatedAt, updated_by: actorId,
      } },
      { session, returnDocument: 'after', timestamps: false },
    ).lean().exec();
  }

  async insertShift(trainerId: Types.ObjectId, draft: ValidDraft, actorId: Types.ObjectId, session: ClientSession): Promise<WorkShift> {
    const [created] = await this.shifts.create([{
      trainer_id: trainerId, start_at: draft.startAt, end_at: draft.endAt, location: draft.location,
      status: 'SCHEDULED', version: 0, created_by: actorId, updated_by: actorId,
    }], { session });
    return created.toObject();
  }

  // US-24-TC10: CAS – chỉ ghi khi ca vẫn SCHEDULED và đúng version client đã xem; ghi xong version + 1.
  // Trả null nếu điều kiện không còn đúng (đã có người sửa trước).
  updateDraft(shiftId: Types.ObjectId, expectedVersion: number, draft: ValidDraft, actorId: Types.ObjectId, session: ClientSession): Promise<WorkShift | null> {
    return this.shifts.findOneAndUpdate(
      { _id: shiftId, status: 'SCHEDULED', version: expectedVersion },
      { $set: { start_at: draft.startAt, end_at: draft.endAt, location: draft.location, updated_by: actorId }, $inc: { version: 1 } },
      { session, returnDocument: 'after' },
    ).lean().exec();
  }

  // US-24-F05: audit ghi cùng transaction với ca; request_key unique nên gửi lại cùng key không thêm audit.
  async insertEvent(event: NewShiftEvent, session: ClientSession): Promise<void> {
    await this.events.create([{
      shift_id: event.shiftId, actor_id: event.actorId, action: event.action,
      before: event.before, after: event.after, reason: event.reason, occurred_at: event.occurredAt, request_key: event.requestKey,
    }], { session });
  }

  // Danh sách lịch của PT: ca bắt đầu trong khoảng ngày lọc, sắp startAt rồi _id tăng dần.
  async listOwn(trainerId: Types.ObjectId, range: DateRange, status: ShiftStatus | undefined, page: number, limit: number) {
    const filter: Record<string, unknown> = { trainer_id: trainerId, start_at: { $gte: range.from, $lt: range.to } };
    if (status) filter.status = status;
    const [items, total] = await Promise.all([
      this.shifts.find(filter).sort({ start_at: 1, _id: 1 }).skip((page - 1) * limit).limit(limit).lean().exec(),
      this.shifts.countDocuments(filter).exec(),
    ]);
    return { items, total };
  }
}
