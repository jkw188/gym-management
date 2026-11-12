// Tầng dữ liệu (US-17 bước 2): cấu trúc collection pt_bookings theo báo cáo mục 4.2.13 – một buổi PT hội viên đặt.
// US-17 chỉ ĐỌC để đếm buổi BOOKED (sessionsReserved); US-27 đọc để loại giờ bận và xem lịch riêng; luồng đặt/hủy/xác nhận buổi thuộc US-28.
// US-28 bước 1: thêm index theo ca và request_key unique; lệnh ensure-indexes tạo các index này trước khi mở writer.
// US-28 bước 2: member_id bắt buộc, bất biến; version bắt buộc (booking cũ được backfill trong ensure-indexes).
// US-28 bước 3: thêm created_by, updated_at cho booking do Member đặt qua API.
// US-29 bước 1: thêm cancelled_at, cancelled_by, cancellation_reason (cùng tên với work_shifts US-25) ghi khi buổi chuyển BOOKED → CANCELLED (US-29-F03).
// US-64 bước 1: thêm nguồn hoàn tất completed_by, completed_actor_type, completion_membership_id, completion_revision (US-64-C01, C04).
import { Schema, Types } from 'mongoose';

export type PtBookingStatus = 'BOOKED' | 'COMPLETED' | 'CANCELLED';

// US-64-C01: ai xác nhận buổi đã dạy – PT tự xác nhận hoặc Admin xác nhận hỗ trợ có lý do.
export type CompletedActorType = 'TRAINER' | 'ADMIN_SUPPORT';
export const COMPLETED_ACTOR_TYPES: CompletedActorType[] = ['TRAINER', 'ADMIN_SUPPORT'];

export interface PtBooking {
  _id: Types.ObjectId;
  id: Types.ObjectId;
  membership_id: Types.ObjectId;
  // US-28 bổ sung: chủ buổi xuyên mọi membership (bắt buộc từ bước 2). US-27 dùng để loại giờ bận của chính Member.
  member_id: Types.ObjectId;
  trainer_id: Types.ObjectId;
  shift_id: Types.ObjectId;
  start_at: Date;
  end_at: Date;
  status: PtBookingStatus;
  request_key: string;
  created_at: Date;
  completed_at?: Date;
  // US-28 bổ sung (US-27-F05 đọc): version và snapshot tên PT, địa điểm lúc đặt để lịch sử không đổi theo dữ liệu mới.
  version: number;
  trainer_name_snapshot?: string;
  location_snapshot?: string;
  // US-28 bước 3: account tạo booking và lần sửa cuối (spec mục 3 "pt_bookings bổ sung"); booking cũ trước US-28 không có.
  created_by?: Types.ObjectId;
  updated_at?: Date;
  // US-29-F03: lúc hủy (giờ server), account người hủy (Member hoặc Staff/Admin), lý do đã trim; chỉ có khi CANCELLED.
  cancelled_at?: Date;
  cancelled_by?: Types.ObjectId;
  cancellation_reason?: string;
  // US-64-C04: account người xác nhận, loại người xác nhận, gói bị trừ buổi lúc hoàn tất.
  // Chỉ có khi đang COMPLETED; Admin rút xác nhận (reopen) thì bỏ, lịch sử nằm trong booking_events.
  completed_by?: Types.ObjectId;
  completed_actor_type?: CompletedActorType;
  completion_membership_id?: Types.ObjectId;
  // US-64-C04: số lần complete/reopen đã xảy ra, tăng 1 mỗi lần; booking mới = 0.
  completion_revision: number;
}

// Mọi trạng thái của buổi PT; lịch riêng của Member gồm cả ba (US-27-F05).
export const PT_BOOKING_STATUSES: PtBookingStatus[] = ['BOOKED', 'COMPLETED', 'CANCELLED'];

export const PtBookingSchema = new Schema<PtBooking>({
  id: { type: Schema.Types.ObjectId, required: true },
  membership_id: { type: Schema.Types.ObjectId, ref: 'Membership', required: true },
  // US-28-G03: bắt buộc và bất biến (immutable) – nâng cấp gói chỉ đổi membership_id/version, không đổi chủ buổi.
  member_id: { type: Schema.Types.ObjectId, ref: 'Member', required: true, immutable: true },
  trainer_id: { type: Schema.Types.ObjectId, required: true },
  shift_id: { type: Schema.Types.ObjectId, required: true },
  start_at: { type: Date, required: true },
  end_at: { type: Date, required: true },
  status: { type: String, required: true, maxlength: 20, enum: PT_BOOKING_STATUSES },
  request_key: { type: String, required: true, maxlength: 80 },
  created_at: { type: Date, required: true },
  completed_at: { type: Date },
  // US-28 bước 2: bắt buộc sau khi ensure-indexes backfill booking cũ (version = 0, member_id, snapshot).
  // version ≥ 0 và là số nguyên (bộ đếm số lần sửa), giống work_shifts và public_sessions.
  version: { type: Number, required: true, min: 0, validate: Number.isInteger },
  trainer_name_snapshot: { type: String, maxlength: 120 },
  location_snapshot: { type: String, maxlength: 120 },
  created_by: { type: Schema.Types.ObjectId, ref: 'Account' },
  updated_at: { type: Date },
  cancelled_at: { type: Date },
  cancelled_by: { type: Schema.Types.ObjectId, ref: 'Account' },
  // US-29-F02: lý do sau trim dài 10–500 ký tự (service kiểm, schema chặn thêm độ dài tối đa).
  cancellation_reason: { type: String, maxlength: 500 },
  completed_by: { type: Schema.Types.ObjectId, ref: 'Account' },
  completed_actor_type: { type: String, enum: COMPLETED_ACTOR_TYPES },
  completion_membership_id: { type: Schema.Types.ObjectId, ref: 'Membership' },
  // US-64-C04: số nguyên ≥ 0, mặc định 0 (booking cũ được backfill trong ensure-indexes).
  completion_revision: { type: Number, default: 0, min: 0, validate: Number.isInteger },
}, { collection: 'pt_bookings', id: false, versionKey: false });

// US-17-F03: đếm buổi BOOKED theo từng gói ngay trong DB.
PtBookingSchema.index({ membership_id: 1, status: 1 }, { name: 'pt_bookings_membership_status' });
// US-27-F03: buổi BOOKED/COMPLETED của một PT giao khoảng ngày đang xem.
PtBookingSchema.index({ trainer_id: 1, status: 1, start_at: 1, end_at: 1 }, { name: 'pt_bookings_trainer_status_time' });
// US-27-F04: buổi BOOKED/COMPLETED của chính Member trên mọi PT; US-27-F05: lịch riêng của Member theo ngày.
PtBookingSchema.index({ member_id: 1, status: 1, start_at: 1, end_at: 1 }, { name: 'pt_bookings_member_status_time' });
// US-30 (spec mục 2): gom học viên distinct theo PT và trạng thái quan hệ BOOKED/COMPLETED.
PtBookingSchema.index({ trainer_id: 1, status: 1, member_id: 1 }, { name: 'pt_bookings_trainer_status_member' });
// US-28-G01 (spec mục 3): tìm booking theo ca khi ca bị hủy/sửa.
PtBookingSchema.index({ shift_id: 1, status: 1 }, { name: 'pt_bookings_shift_status' });
// US-28 (spec mục 3): request_key = SHA-256 của actor|operation|key theo EN-02, unique để một yêu cầu chỉ tạo một booking.
PtBookingSchema.index({ request_key: 1 }, { unique: true, name: 'pt_bookings_request_key_unique' });
