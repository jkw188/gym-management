// Tầng kiểm thử backend (Jest, unit, không cần DB): US-28 bước 2.
// Kiểm tra cấu trúc pt_bookings sau khi bổ sung member_id/snapshot/version: member_id bắt buộc và bất biến, snapshot ≤ 120, version ≥ 0.
// Hợp đồng test đặt ra cho Builder (US-28 bước 2, theo bảng "pt_bookings bổ sung" ở mục 3 và G03 của spec):
//   PtBookingSchema (src/modules/bookings/schemas/pt-booking.schema.ts):
//   - member_id: ObjectId, BẮT BUỘC và BẤT BIẾN (Mongoose immutable) – nâng cấp gói chỉ đổi membership_id/version, không đổi member_id.
//   - version: số nguyên ≥ 0 (đã có từ US-27), BẮT BUỘC sau backfill.
//   - trainer_name_snapshot, location_snapshot: chuỗi tối đa 120 ký tự.
//   Kiểm bằng validateSync() của Mongoose trên model tạo từ schema (không kết nối DB).
import mongoose, { Types } from 'mongoose';
import { PtBookingSchema } from '../src/modules/bookings/schemas/pt-booking.schema';

// Model riêng cho test, không đụng model của ứng dụng.
const Booking = mongoose.model('PtBookingSchemaTestUS28', PtBookingSchema);

function validBooking(overrides: Record<string, unknown> = {}) {
  const id = new Types.ObjectId();
  return {
    _id: id, id, membership_id: new Types.ObjectId(), member_id: new Types.ObjectId(), trainer_id: new Types.ObjectId(),
    shift_id: new Types.ObjectId(), start_at: new Date('2026-11-25T01:00:00.000Z'), end_at: new Date('2026-11-25T02:00:00.000Z'),
    status: 'BOOKED', request_key: 'a'.repeat(64), created_at: new Date(), version: 0,
    trainer_name_snapshot: 'PT Trần Văn Bình', location_snapshot: 'Phòng PT 1', ...overrides,
  };
}

const errorPaths = (doc: mongoose.Document) => Object.keys(doc.validateSync()?.errors ?? {});

describe('US-28 bước 2: cấu trúc pt_bookings bổ sung', () => {
  it('US-28-G03: booking đầy đủ field bổ sung → hợp lệ', () => {
    expect(new Booking(validBooking()).validateSync()).toBeUndefined();
  });

  it('US-28-G03: thiếu member_id → lỗi ở member_id', () => {
    expect(errorPaths(new Booking(validBooking({ member_id: undefined })))).toContain('member_id');
  });

  it('US-28-G03: member_id là bất biến (immutable): đổi sau khi tạo thì giá trị cũ được giữ', () => {
    expect(PtBookingSchema.path('member_id').options.immutable).toBe(true);
    const original = new Types.ObjectId();
    const doc = new Booking(validBooking({ member_id: original }));
    doc.isNew = false; // giả lập document đã lưu
    doc.set('member_id', new Types.ObjectId());
    expect(String(doc.get('member_id'))).toBe(String(original));
  });

  it('US-28-G03: thiếu version → lỗi ở version; version âm hoặc số lẻ → lỗi', () => {
    expect(errorPaths(new Booking(validBooking({ version: undefined })))).toContain('version');
    expect(errorPaths(new Booking(validBooking({ version: -1 })))).toContain('version');
    expect(errorPaths(new Booking(validBooking({ version: 1.5 })))).toContain('version');
  });

  it('US-28-G03: snapshot tên PT và địa điểm dài 120 ký tự → hợp lệ; 121 ký tự → lỗi', () => {
    expect(new Booking(validBooking({ trainer_name_snapshot: 'a'.repeat(120), location_snapshot: 'b'.repeat(120) })).validateSync()).toBeUndefined();
    expect(errorPaths(new Booking(validBooking({ trainer_name_snapshot: 'a'.repeat(121) })))).toContain('trainer_name_snapshot');
    expect(errorPaths(new Booking(validBooking({ location_snapshot: 'b'.repeat(121) })))).toContain('location_snapshot');
  });
});
