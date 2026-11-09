// Tầng dữ liệu (US-17 bước 2): cấu trúc collection pt_bookings theo báo cáo mục 4.2.13 – một buổi PT hội viên đặt.
// US-17 chỉ ĐỌC để đếm buổi BOOKED (sessionsReserved); US-27 đọc để loại giờ bận và xem lịch riêng; luồng đặt/hủy/xác nhận buổi thuộc US-28.
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
  // US-28 bổ sung (US-27-F05 đọc): version và snapshot tên PT, địa điểm lúc đặt để lịch sử không đổi theo dữ liệu mới.
  version?: number;
  trainer_name_snapshot?: string;
  location_snapshot?: string;
}

// Mọi trạng thái của buổi PT; lịch riêng của Member gồm cả ba (US-27-F05).
export const PT_BOOKING_STATUSES: PtBookingStatus[] = ['BOOKED', 'COMPLETED', 'CANCELLED'];

export const PtBookingSchema = new Schema<PtBooking>({
  id: { type: Schema.Types.ObjectId, required: true },
  membership_id: { type: Schema.Types.ObjectId, ref: 'Membership', required: true },
  member_id: { type: Schema.Types.ObjectId, ref: 'Member' },
  trainer_id: { type: Schema.Types.ObjectId, required: true },
  shift_id: { type: Schema.Types.ObjectId, required: true },
  start_at: { type: Date, required: true },
  end_at: { type: Date, required: true },
  status: { type: String, required: true, maxlength: 20, enum: PT_BOOKING_STATUSES },
  request_key: { type: String, required: true, maxlength: 80 },
  created_at: { type: Date, required: true },
  completed_at: { type: Date },
  // Phần US-28 bổ sung; US-28 sẽ quyết định bắt buộc khi có luồng ghi.
  version: { type: Number, min: 0 },
  trainer_name_snapshot: { type: String, maxlength: 120 },
  location_snapshot: { type: String, maxlength: 120 },
}, { collection: 'pt_bookings', id: false, versionKey: false });

// US-17-F03: đếm buổi BOOKED theo từng gói ngay trong DB.
PtBookingSchema.index({ membership_id: 1, status: 1 }, { name: 'pt_bookings_membership_status' });
// US-27-F03: buổi BOOKED/COMPLETED của một PT giao khoảng ngày đang xem.
PtBookingSchema.index({ trainer_id: 1, status: 1, start_at: 1, end_at: 1 }, { name: 'pt_bookings_trainer_status_time' });
// US-27-F04: buổi BOOKED/COMPLETED của chính Member trên mọi PT; US-27-F05: lịch riêng của Member theo ngày.
PtBookingSchema.index({ member_id: 1, status: 1, start_at: 1, end_at: 1 }, { name: 'pt_bookings_member_status_time' });
