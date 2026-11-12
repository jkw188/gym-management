
import { Schema, Types } from 'mongoose';

// Tầng dữ liệu US-17, US-27, US-28, US-29.
export type PtBookingStatus = 'BOOKED' | 'COMPLETED' | 'CANCELLED';

export interface PtBooking {
  _id: Types.ObjectId;
  id: Types.ObjectId;
  membership_id: Types.ObjectId;
  member_id: Types.ObjectId;
  trainer_id: Types.ObjectId;
  shift_id: Types.ObjectId;
  start_at: Date;
  end_at: Date;
  status: PtBookingStatus;
  request_key: string;
  created_at: Date;
  completed_at?: Date;

  // US-28
  version: number;
  trainer_name_snapshot?: string;
  location_snapshot?: string;
  created_by?: Types.ObjectId;
  updated_at?: Date;

  // US-29
  cancelled_at?: Date;
  cancelled_by?: Types.ObjectId;
  cancellation_reason?: string;
}

// US-27: lịch riêng của Member gồm cả ba trạng thái.
export const PT_BOOKING_STATUSES: PtBookingStatus[] = [
  'BOOKED',
  'COMPLETED',
  'CANCELLED',
];

export const PtBookingSchema = new Schema<PtBooking>({
  id: {
    type: Schema.Types.ObjectId,
    required: true,
  },
  membership_id: {
    type: Schema.Types.ObjectId,
    ref: 'Membership',
    required: true,
  },
  // US-28: chủ buổi bắt buộc và bất biến.
  member_id: {
    type: Schema.Types.ObjectId,
    ref: 'Member',
    required: true,
    immutable: true,
  },
  trainer_id: {
    type: Schema.Types.ObjectId,
    required: true,
  },
  shift_id: {
    type: Schema.Types.ObjectId,
    required: true,
  },
  start_at: {
    type: Date,
    required: true,
  },
  end_at: {
    type: Date,
    required: true,
  },
  status: {
    type: String,
    required: true,
    maxlength: 20,
    enum: PT_BOOKING_STATUSES,
  },
  request_key: {
    type: String,
    required: true,
    maxlength: 80,
  },
  created_at: {
    type: Date,
    required: true,
  },
  completed_at: {
    type: Date,
  },

  // US-28: version được backfill cho booking cũ.
  version: {
    type: Number,
    required: true,
    min: 0,
    validate: Number.isInteger,
  },
  trainer_name_snapshot: {
    type: String,
    maxlength: 120,
  },
  location_snapshot: {
    type: String,
    maxlength: 120,
  },
  created_by: {
    type: Schema.Types.ObjectId,
    ref: 'Account',
  },
  updated_at: {
    type: Date,
  },

  // US-29: thông tin hủy booking.
  cancelled_at: {
    type: Date,
  },
  cancelled_by: {
    type: Schema.Types.ObjectId,
    ref: 'Account',
  },
  cancellation_reason: {
    type: String,
    maxlength: 500,
  },
}, {
  collection: 'pt_bookings',
  id: false,
  versionKey: false,
});

// US-17: đếm buổi BOOKED theo membership.
PtBookingSchema.index(
  { membership_id: 1, status: 1 },
  { name: 'pt_bookings_membership_status' },
);

// US-27: tra cứu lịch của PT.
PtBookingSchema.index(
  { trainer_id: 1, status: 1, start_at: 1, end_at: 1 },
  { name: 'pt_bookings_trainer_status_time' },
);

// US-27: tra cứu lịch riêng của Member.
PtBookingSchema.index(
  { member_id: 1, status: 1, start_at: 1, end_at: 1 },
  { name: 'pt_bookings_member_status_time' },
);

// US-28: tìm booking theo ca.
PtBookingSchema.index(
  { shift_id: 1, status: 1 },
  { name: 'pt_bookings_shift_status' },
);

// US-28: request_key unique.
PtBookingSchema.index(
  { request_key: 1 },
  {
    unique: true,
    name: 'pt_bookings_request_key_unique',
  },
);
