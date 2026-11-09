// Tầng dữ liệu (US-17 bước 2): cấu trúc collection pt_bookings theo báo cáo mục 4.2.13 – một buổi PT hội viên đặt.
// US-17 chỉ ĐỌC để đếm buổi BOOKED (sessionsReserved); US-27 đọc để loại giờ bận; luồng đặt/hủy/xác nhận buổi thuộc US-28.
import { Schema, Types } from 'mongoose';

export type PtBookingStatus = 'BOOKED' | 'COMPLETED' | 'CANCELLED';

export interface PtBooking {
  _id: Types.ObjectId;
  id: Types.ObjectId;
  membership_id: Types.ObjectId;
  // US-28 bổ sung: chủ buổi xuyên mọi membership. US-27 dùng để loại giờ bận của chính Member.
  member_id?: Types.ObjectId;
  trainer_id: Types.ObjectId;
  shift_id: Types.ObjectId;
  start_at: Date;
  end_at: Date;
  status: PtBookingStatus;
  request_key: string;
  created_at: Date;
  completed_at?: Date;
}

export const PtBookingSchema = new Schema<PtBooking>({
  id: { type: Schema.Types.ObjectId, required: true },
  membership_id: { type: Schema.Types.ObjectId, ref: 'Membership', required: true },
  member_id: { type: Schema.Types.ObjectId, ref: 'Member' },
  trainer_id: { type: Schema.Types.ObjectId, required: true },
  shift_id: { type: Schema.Types.ObjectId, required: true },
  start_at: { type: Date, required: true },
  end_at: { type: Date, required: true },
  status: { type: String, required: true, maxlength: 20, enum: ['BOOKED', 'COMPLETED', 'CANCELLED'] },
  request_key: { type: String, required: true, maxlength: 80 },
  created_at: { type: Date, required: true },
  completed_at: { type: Date },
}, { collection: 'pt_bookings', id: false, versionKey: false });

// US-17-F03: đếm buổi BOOKED theo từng gói ngay trong DB.
PtBookingSchema.index({ membership_id: 1, status: 1 }, { name: 'pt_bookings_membership_status' });
// US-27-F03: buổi BOOKED/COMPLETED của một PT giao khoảng ngày đang xem.
PtBookingSchema.index({ trainer_id: 1, status: 1, start_at: 1, end_at: 1 }, { name: 'pt_bookings_trainer_status_time' });
// US-27-F04: buổi BOOKED/COMPLETED của chính Member trên mọi PT.
PtBookingSchema.index({ member_id: 1, status: 1, start_at: 1, end_at: 1 }, { name: 'pt_bookings_member_status_time' });
