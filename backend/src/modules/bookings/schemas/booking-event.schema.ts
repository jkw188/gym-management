// Tầng dữ liệu (US-29 bước 2): cấu trúc collection booking_events, mỗi document là một dòng audit của buổi PT.
// Ghi cùng transaction với lệnh hủy (US-29-F05); request_key unique để một yêu cầu chỉ có một dòng audit.
import { Schema, Types } from 'mongoose';
import { PT_BOOKING_STATUSES, PtBookingStatus } from './pt-booking.schema';

// US-29 chỉ có hành động hủy; hoàn tất buổi (S07) sẽ thêm hành động riêng.
export type BookingEventAction = 'CANCELLED';
export const BOOKING_EVENT_ACTIONS: BookingEventAction[] = ['CANCELLED'];
// Vai trò người thao tác lúc ghi audit: Member tự hủy, Staff/Admin hủy hỗ trợ.
export type BookingEventActorRole = 'MEMBER' | 'STAFF' | 'ADMIN';
export const BOOKING_EVENT_ACTOR_ROLES: BookingEventActorRole[] = ['MEMBER', 'STAFF', 'ADMIN'];

export interface BookingEvent {
  _id: Types.ObjectId;
  booking_id: Types.ObjectId;
  member_id: Types.ObjectId;
  // US-29-TC04: gói của booking TẠI LÚC thao tác (sau nâng cấp là gói mới).
  membership_id: Types.ObjectId;
  // Account người thao tác (Member hoặc Staff/Admin).
  actor_id: Types.ObjectId;
  actor_role: BookingEventActorRole;
  action: BookingEventAction;
  reason: string;
  occurred_at: Date;
  before_status: PtBookingStatus;
  after_status: PtBookingStatus;
  // SHA-256 (hex 64 ký tự) của actor|operation|Idempotency-Key theo EN-02; không lưu key thô.
  request_key: string;
}

export const BookingEventSchema = new Schema<BookingEvent>({
  booking_id: { type: Schema.Types.ObjectId, ref: 'PtBooking', required: true },
  member_id: { type: Schema.Types.ObjectId, ref: 'Member', required: true },
  membership_id: { type: Schema.Types.ObjectId, ref: 'Membership', required: true },
  actor_id: { type: Schema.Types.ObjectId, ref: 'Account', required: true },
  actor_role: { type: String, required: true, enum: BOOKING_EVENT_ACTOR_ROLES },
  action: { type: String, required: true, enum: BOOKING_EVENT_ACTIONS },
  // US-29-F02: lý do đã trim, tối đa 500 ký tự như cancellation_reason.
  reason: { type: String, required: true, maxlength: 500 },
  occurred_at: { type: Date, required: true },
  before_status: { type: String, required: true, enum: PT_BOOKING_STATUSES },
  after_status: { type: String, required: true, enum: PT_BOOKING_STATUSES },
  request_key: { type: String, required: true, maxlength: 120 },
}, { collection: 'booking_events', versionKey: false, strict: 'throw' });

// US-29-TC05 (spec mục 2): cùng request_key chỉ có một audit.
BookingEventSchema.index({ request_key: 1 }, { unique: true, name: 'booking_events_request_key_unique' });
// US-29-TC05: xem lịch sử một buổi theo thời gian.
BookingEventSchema.index({ booking_id: 1, occurred_at: 1 }, { name: 'booking_events_booking_time' });
