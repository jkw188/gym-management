// Tầng dữ liệu (US-29 bước 2): cấu trúc collection booking_events, mỗi document là một dòng audit của buổi PT.
// Ghi cùng transaction với lệnh hủy (US-29-F05); request_key unique để một yêu cầu chỉ có một dòng audit.
// US-64 bước 1: thêm dòng COMPLETE (PT/Admin xác nhận đã dạy) với revision, used và version trước–sau (US-64-C04).
// US-64 bước 3: thêm dòng REOPEN (Admin rút xác nhận sai, US-64-C02), cùng các field như COMPLETE và bắt buộc có lý do.
import { Schema, Types } from 'mongoose';
import { PT_BOOKING_STATUSES, PtBookingStatus } from './pt-booking.schema';

// CANCELLED: hủy buổi (US-29). COMPLETE: xác nhận buổi đã dạy (US-64). REOPEN: Admin rút xác nhận sai (US-64-C02).
export type BookingEventAction = 'CANCELLED' | 'COMPLETE' | 'REOPEN';
export const BOOKING_EVENT_ACTIONS: BookingEventAction[] = ['CANCELLED', 'COMPLETE', 'REOPEN'];
// Vai trò người thao tác lúc ghi audit: Member tự hủy, Staff/Admin hủy hỗ trợ, PT xác nhận đã dạy (US-64).
export type BookingEventActorRole = 'MEMBER' | 'STAFF' | 'ADMIN' | 'TRAINER';
export const BOOKING_EVENT_ACTOR_ROLES: BookingEventActorRole[] = ['MEMBER', 'STAFF', 'ADMIN', 'TRAINER'];

export interface BookingEvent {
  _id: Types.ObjectId;
  booking_id: Types.ObjectId;
  member_id: Types.ObjectId;
  // US-29-TC04: gói của booking TẠI LÚC thao tác (sau nâng cấp là gói mới).
  membership_id: Types.ObjectId;
  // Account người thao tác (Member, PT hoặc Staff/Admin).
  actor_id: Types.ObjectId;
  actor_role: BookingEventActorRole;
  action: BookingEventAction;
  // Bắt buộc với CANCELLED (US-29) và REOPEN (US-64-C02); PT xác nhận đã dạy thì không cần lý do.
  reason?: string;
  occurred_at: Date;
  before_status: PtBookingStatus;
  after_status: PtBookingStatus;
  // SHA-256 (hex 64 ký tự) của actor|operation|Idempotency-Key theo EN-02; không lưu key thô.
  request_key: string;
  // US-64-C04: chỉ có ở dòng COMPLETE/REOPEN – revision sau lần thao tác này, sessions_used và version trước–sau.
  completion_revision?: number;
  used_before?: number;
  used_after?: number;
  version_before?: number;
  version_after?: number;
}

// Dòng hủy (US-29-F02) và dòng Admin rút xác nhận (US-64-C02) bắt buộc có lý do.
function needsReason(this: BookingEvent): boolean {
  return this.action === 'CANCELLED' || this.action === 'REOPEN';
}

// US-64-C04: dòng COMPLETE và REOPEN bắt buộc có revision, used và version trước–sau.
function isCompletionEvent(this: BookingEvent): boolean {
  return this.action === 'COMPLETE' || this.action === 'REOPEN';
}

// Các field số của dòng COMPLETE/REOPEN: bắt buộc với hai loại dòng này, là số nguyên ≥ 0.
const completionNumber = { type: Number, required: isCompletionEvent, min: 0, validate: Number.isInteger };

export const BookingEventSchema = new Schema<BookingEvent>({
  booking_id: { type: Schema.Types.ObjectId, ref: 'PtBooking', required: true },
  member_id: { type: Schema.Types.ObjectId, ref: 'Member', required: true },
  membership_id: { type: Schema.Types.ObjectId, ref: 'Membership', required: true },
  actor_id: { type: Schema.Types.ObjectId, ref: 'Account', required: true },
  actor_role: { type: String, required: true, enum: BOOKING_EVENT_ACTOR_ROLES },
  action: { type: String, required: true, enum: BOOKING_EVENT_ACTIONS },
  // US-29-F02: lý do đã trim, tối đa 500 ký tự như cancellation_reason.
  reason: { type: String, required: needsReason, maxlength: 500 },
  occurred_at: { type: Date, required: true },
  before_status: { type: String, required: true, enum: PT_BOOKING_STATUSES },
  after_status: { type: String, required: true, enum: PT_BOOKING_STATUSES },
  request_key: { type: String, required: true, maxlength: 120 },
  completion_revision: completionNumber,
  used_before: completionNumber,
  used_after: completionNumber,
  version_before: completionNumber,
  version_after: completionNumber,
}, { collection: 'booking_events', versionKey: false, strict: 'throw' });

// US-29-TC05 (spec mục 2): cùng request_key chỉ có một audit.
BookingEventSchema.index({ request_key: 1 }, { unique: true, name: 'booking_events_request_key_unique' });
// US-29-TC05: xem lịch sử một buổi theo thời gian.
BookingEventSchema.index({ booking_id: 1, occurred_at: 1 }, { name: 'booking_events_booking_time' });
// US-64-C04 (spec mục 3): mỗi lượt complete/reopen của một booking chỉ có một dòng audit.
// Dòng CANCELLED không có completion_revision (MongoDB coi là null); booking chỉ hủy được một lần nên không trùng.
BookingEventSchema.index({ booking_id: 1, completion_revision: 1, action: 1 },
  { unique: true, name: 'booking_events_booking_revision_action_unique' });
