// Tầng kiểm thử backend (Jest, unit, không cần DB): US-64 bước 1.
// Kiểm tra cấu trúc pt_bookings và booking_events sau khi bổ sung nguồn hoàn tất (completion source), revision và dòng audit COMPLETE.
// Hợp đồng test đặt ra cho Builder (US-64 bước 1, theo bảng collection mục 3 và US-64-C01/C04 của spec):
//   PtBookingSchema (src/modules/bookings/schemas/pt-booking.schema.ts) thêm:
//   - completed_by: ObjectId (account người xác nhận), không bắt buộc.
//   - completed_actor_type: 'TRAINER' (PT tự xác nhận) | 'ADMIN_SUPPORT' (Admin xác nhận hỗ trợ, C01), không bắt buộc.
//   - completion_membership_id: ObjectId gói bị trừ buổi lúc hoàn tất, không bắt buộc.
//   - completion_revision: số nguyên ≥ 0, mặc định 0 (booking mới chưa hoàn tất lần nào).
//   BookingEventSchema (src/modules/bookings/schemas/booking-event.schema.ts):
//   - action thêm 'COMPLETE' (tên theo C04); actor_role thêm 'TRAINER'.
//   - Dòng COMPLETE bắt buộc completion_revision, used_before, used_after, version_before, version_after (số nguyên ≥ 0);
//     reason không bắt buộc với COMPLETE. Dòng CANCELLED của US-29 giữ nguyên luật cũ (bắt buộc reason, không cần các field trên).
//   - Index unique (booking_id, completion_revision, action).
import mongoose, { Types } from 'mongoose';
import { PtBookingSchema } from '../src/modules/bookings/schemas/pt-booking.schema';
import { BookingEventSchema } from '../src/modules/bookings/schemas/booking-event.schema';

// Model riêng cho test, không đụng model của ứng dụng.
const Booking = mongoose.model('PtBookingCompletionTestUS64', PtBookingSchema);
const BookingEvent = mongoose.model('BookingEventCompletionTestUS64', BookingEventSchema);

const errorPaths = (doc: mongoose.Document) => Object.keys(doc.validateSync()?.errors ?? {});

function completedBooking(overrides: Record<string, unknown> = {}) {
  const id = new Types.ObjectId();
  const membershipId = new Types.ObjectId();
  return {
    _id: id, id, membership_id: membershipId, member_id: new Types.ObjectId(), trainer_id: new Types.ObjectId(),
    shift_id: new Types.ObjectId(), start_at: new Date('2026-11-25T01:00:00.000Z'), end_at: new Date('2026-11-25T02:00:00.000Z'),
    status: 'COMPLETED', request_key: 'a'.repeat(64), created_at: new Date(), version: 2,
    completed_at: new Date('2026-11-25T02:05:00.000Z'), completed_by: new Types.ObjectId(), completed_actor_type: 'TRAINER',
    completion_membership_id: membershipId, completion_revision: 1, ...overrides,
  };
}

function completeEvent(overrides: Record<string, unknown> = {}) {
  return {
    booking_id: new Types.ObjectId(), member_id: new Types.ObjectId(), membership_id: new Types.ObjectId(),
    actor_id: new Types.ObjectId(), actor_role: 'TRAINER', action: 'COMPLETE', occurred_at: new Date(),
    before_status: 'BOOKED', after_status: 'COMPLETED', request_key: 'b'.repeat(64),
    completion_revision: 1, used_before: 2, used_after: 3, version_before: 4, version_after: 5, ...overrides,
  };
}

function cancelEvent(overrides: Record<string, unknown> = {}) {
  return {
    booking_id: new Types.ObjectId(), member_id: new Types.ObjectId(), membership_id: new Types.ObjectId(),
    actor_id: new Types.ObjectId(), actor_role: 'MEMBER', action: 'CANCELLED', reason: 'Bận việc đột xuất',
    occurred_at: new Date(), before_status: 'BOOKED', after_status: 'CANCELLED', request_key: 'c'.repeat(64), ...overrides,
  };
}

describe('US-64 bước 1: pt_bookings bổ sung nguồn hoàn tất', () => {
  it('US-64-C04: booking COMPLETED đủ completed_by, completed_actor_type, completion_membership_id, completion_revision → hợp lệ', () => {
    expect(new Booking(completedBooking()).validateSync()).toBeUndefined();
  });

  it('US-64-C04: booking mới không truyền completion_revision → mặc định 0', () => {
    const doc = new Booking(completedBooking({ status: 'BOOKED', completion_revision: undefined, completed_at: undefined,
      completed_by: undefined, completed_actor_type: undefined, completion_membership_id: undefined }));
    expect(doc.validateSync()).toBeUndefined();
    expect(doc.get('completion_revision')).toBe(0);
  });

  it('US-64-C04: completion_revision âm hoặc số lẻ → lỗi ở completion_revision', () => {
    expect(errorPaths(new Booking(completedBooking({ completion_revision: -1 })))).toContain('completion_revision');
    expect(errorPaths(new Booking(completedBooking({ completion_revision: 1.5 })))).toContain('completion_revision');
  });

  it('US-64-C01: completed_actor_type nhận TRAINER và ADMIN_SUPPORT', () => {
    expect(new Booking(completedBooking({ completed_actor_type: 'TRAINER' })).validateSync()).toBeUndefined();
    expect(new Booking(completedBooking({ completed_actor_type: 'ADMIN_SUPPORT' })).validateSync()).toBeUndefined();
  });

  it('US-64-C01: completed_actor_type ngoài danh sách (STAFF, MEMBER) → lỗi', () => {
    expect(errorPaths(new Booking(completedBooking({ completed_actor_type: 'STAFF' })))).toContain('completed_actor_type');
    expect(errorPaths(new Booking(completedBooking({ completed_actor_type: 'MEMBER' })))).toContain('completed_actor_type');
  });
});

describe('US-64 bước 1: booking_events có dòng COMPLETE', () => {
  it('US-64-C04: dòng COMPLETE của PT đủ revision, used/version trước–sau, không có reason → hợp lệ', () => {
    expect(new BookingEvent(completeEvent()).validateSync()).toBeUndefined();
  });

  it.each(['completion_revision', 'used_before', 'used_after', 'version_before', 'version_after'])(
    'US-64-C04: dòng COMPLETE thiếu %s → lỗi ở field đó', field => {
      expect(errorPaths(new BookingEvent(completeEvent({ [field]: undefined })))).toContain(field);
    });

  it.each(['completion_revision', 'used_before', 'used_after', 'version_before', 'version_after'])(
    'US-64-C04: dòng COMPLETE có %s âm hoặc số lẻ → lỗi', field => {
      expect(errorPaths(new BookingEvent(completeEvent({ [field]: -1 })))).toContain(field);
      expect(errorPaths(new BookingEvent(completeEvent({ [field]: 1.5 })))).toContain(field);
    });

  it('US-64-C04: dòng CANCELLED của US-29 (không có field hoàn tất) vẫn hợp lệ; thiếu reason vẫn lỗi', () => {
    expect(new BookingEvent(cancelEvent()).validateSync()).toBeUndefined();
    expect(errorPaths(new BookingEvent(cancelEvent({ reason: undefined })))).toContain('reason');
  });

  it('US-64-C04: action ngoài danh sách → lỗi', () => {
    expect(errorPaths(new BookingEvent(completeEvent({ action: 'DELETE' })))).toContain('action');
  });

  it('US-64-C04 (mục 3): schema khai báo index unique (booking_id, completion_revision, action)', () => {
    const found = BookingEventSchema.indexes().find(([keys]) =>
      JSON.stringify(keys) === JSON.stringify({ booking_id: 1, completion_revision: 1, action: 1 }));
    expect(found).toBeDefined();
    expect(found?.[1]?.unique).toBe(true);
  });
});
