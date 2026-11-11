// Tầng dữ liệu – migration vận hành (US-28 bước 1–2, US-29 bước 2): chạy trong lệnh ensure-indexes, TRƯỚC khi mở writer lịch.
// Kiểm HẾT dữ liệu lịch cũ trước, có vi phạm thì dừng và không sửa gì; hợp lệ thì tạo index, backfill booking cũ, cuối cùng tạo guard.
// US-64 bước 1: thêm backfill nguồn hoàn tất (completion_revision, completion_membership_id) sau khi đã đối chiếu used/BOOKED.
import { Long, ObjectId } from 'mongodb';
import { Connection } from 'mongoose';
import { BookingEventSchema } from '../bookings/schemas/booking-event.schema';
import { PtBookingSchema } from '../bookings/schemas/pt-booking.schema';
import { SCHEDULE_GUARD_ID } from '../../infrastructure/transaction/data-guards.service';

// Booking còn chiếm giờ (CANCELLED thì không).
const ACTIVE_STATUSES = ['BOOKED', 'COMPLETED'];

// Một booking kèm dữ liệu tra cứu được qua $lookup (xem loadBookings).
interface BookingRow {
  _id: ObjectId;
  trainer_id: ObjectId;
  status: string;
  start_at: Date;
  end_at: Date;
  member_id?: ObjectId;
  trainer_name_snapshot?: string;
  location_snapshot?: string;
  derived_member_id?: ObjectId; // member suy ra qua membership → sale
  trainer_name?: string; // accounts.full_name của PT, dùng làm snapshot
  shift_location?: string; // work_shifts.location, dùng làm snapshot
}

export async function ensureSchedulingIntegrity(connection: Connection): Promise<void> {
  const bookings = await loadBookings(connection);

  // 1. Kiểm trước, chưa sửa gì: có vi phạm thì dừng ngay, dữ liệu và guard giữ nguyên.
  assertOwnersResolvable(bookings);
  const active = bookings.filter(booking => ACTIVE_STATUSES.includes(booking.status));
  assertNoOverlap(active, booking => String(booking.trainer_id), 'trainer_overlap');
  // US-28-F04: một Member không có hai buổi trùng giờ trên mọi PT/gói (dùng member suy ra, booking cũ chưa có member_id).
  assertNoOverlap(active, booking => String(booking.derived_member_id), 'member_overlap');
  await assertQuotaNotExceeded(connection);

  // 2. Index theo spec mục 3 (khai báo trong PtBookingSchema để chỉ có một nơi định nghĩa).
  await connection.model('PtBooking', PtBookingSchema).createIndexes();
  // US-29 bước 2: index booking_events (request_key unique, booking_id + occurred_at) phải có trước khi mở lệnh hủy.
  // US-64-C04: thêm index unique (booking_id, completion_revision, action) trước khi mở lệnh hoàn tất.
  await connection.model('BookingEvent', BookingEventSchema).createIndexes();

  // 3. US-28-G03: backfill member_id và snapshot còn thiếu của booking cũ.
  await backfillBookings(connection, bookings);

  // 4. Booking tạo trước US-28 chưa có version → đặt 0; booking đã có version giữ nguyên.
  await connection.collection('pt_bookings').updateMany({ version: { $exists: false } }, { $set: { version: 0 } });

  // 5. US-64-C04/F02: backfill nguồn hoàn tất cho booking cũ. Chạy SAU bước 1 (đã đối chiếu used + BOOKED ≤ quota).
  await backfillCompletionSource(connection);

  // 6. US-28-G01: tạo guard sau cùng, chỉ khi chưa có ($setOnInsert) → chạy lại không đổi revision đang có.
  await connection.db!.collection<{ _id: string; revision: Long }>('schedule_guards').updateOne(
    { _id: SCHEDULE_GUARD_ID }, { $setOnInsert: { revision: Long.ZERO } }, { upsert: true });
}

// Đọc mọi booking một lần, kèm member suy ra (membership → sale), tên PT (trainer → account) và địa điểm ca.
async function loadBookings(connection: Connection): Promise<BookingRow[]> {
  return connection.collection('pt_bookings').aggregate<BookingRow>([
    { $lookup: { from: 'memberships', localField: 'membership_id', foreignField: '_id', as: 'membership' } },
    { $lookup: { from: 'service_sales', localField: 'membership.service_sale_id', foreignField: '_id', as: 'sale' } },
    { $lookup: { from: 'trainers', localField: 'trainer_id', foreignField: '_id', as: 'trainer' } },
    { $lookup: { from: 'accounts', localField: 'trainer.account_id', foreignField: '_id', as: 'account' } },
    { $lookup: { from: 'work_shifts', localField: 'shift_id', foreignField: '_id', as: 'shift' } },
    { $project: {
      trainer_id: 1, status: 1, start_at: 1, end_at: 1, member_id: 1, trainer_name_snapshot: 1, location_snapshot: 1,
      derived_member_id: { $first: '$sale.member_id' },
      trainer_name: { $first: '$account.full_name' },
      shift_location: { $first: '$shift.location' },
    } },
  ]).toArray();
}

// US-28-G03: mỗi booking phải tìm được chủ qua membership → sale; booking đã có member_id phải khớp chủ đó.
function assertOwnersResolvable(bookings: BookingRow[]): void {
  for (const booking of bookings) {
    // Mồ côi (không có membership hoặc membership không có sale) → không đoán member.
    if (!booking.derived_member_id) throw scheduleDataInvalid('orphan_booking', String(booking._id));
    // Đã có member_id nhưng khác chủ của gói → không ghi đè, để người vận hành đối chiếu.
    if (booking.member_id && !booking.member_id.equals(booking.derived_member_id)) {
      throw scheduleDataInvalid('member_mismatch', String(booking._id));
    }
  }
}

// Hai booking cùng nhóm (cùng PT, hoặc cùng Member) không được giao nhau.
// Sắp xếp theo nhóm rồi giờ bắt đầu: trong mỗi nhóm chỉ cần nhớ giờ kết thúc muộn nhất đã gặp;
// booking tiếp theo bắt đầu TRƯỚC giờ đó là giao nhau (bắt đầu đúng bằng là tiếp giáp, hợp lệ).
function assertNoOverlap(bookings: BookingRow[], groupOf: (booking: BookingRow) => string, kind: string): void {
  const sorted = [...bookings].sort((a, b) =>
    groupOf(a).localeCompare(groupOf(b)) || a.start_at.getTime() - b.start_at.getTime());
  let currentGroup = '';
  let latestEnd = 0;
  for (const booking of sorted) {
    if (groupOf(booking) !== currentGroup) {
      currentGroup = groupOf(booking);
      latestEnd = 0;
    }
    if (booking.start_at.getTime() < latestEnd) throw scheduleDataInvalid(kind, String(booking._id));
    latestEnd = Math.max(latestEnd, booking.end_at.getTime());
  }
}

// US-28-F03: used + số buổi BOOKED của một gói không được vượt quota (sessions_snapshot của sale).
async function assertQuotaNotExceeded(connection: Connection): Promise<void> {
  // Đếm buổi BOOKED theo từng membership.
  const bookedCounts = await connection.collection('pt_bookings').aggregate<{ _id: unknown; count: number }>([
    { $match: { status: 'BOOKED' } },
    { $group: { _id: '$membership_id', count: { $sum: 1 } } },
  ]).toArray();
  const reservedByMembership = new Map(bookedCounts.map(row => [String(row._id), row.count]));

  // Mỗi membership kèm quota lấy từ sale của nó.
  const memberships = connection.collection('memberships').aggregate<{ _id: unknown; used?: number; quota?: number }>([
    { $lookup: { from: 'service_sales', localField: 'service_sale_id', foreignField: '_id', as: 'sale' } },
    { $project: { used: '$sessions_used', quota: { $first: '$sale.sessions_snapshot' } } },
  ]);
  for await (const membership of memberships) {
    if (membership.quota === undefined || membership.quota === null) continue; // gói mồ côi: không có sale để so
    const used = Number(membership.used ?? 0);
    const reserved = reservedByMembership.get(String(membership._id)) ?? 0;
    if (used + reserved > Number(membership.quota)) throw scheduleDataInvalid('quota_exceeded', String(membership._id));
  }
}

// US-28-G03: chỉ ghi field CÒN THIẾU. Snapshot đã có giữ nguyên (lịch sử); không tìm thấy nguồn thì để trống.
async function backfillBookings(connection: Connection, bookings: BookingRow[]): Promise<void> {
  for (const booking of bookings) {
    const missing: Record<string, unknown> = {};
    if (!booking.member_id) missing.member_id = booking.derived_member_id;
    if (booking.trainer_name_snapshot === undefined && booking.trainer_name) missing.trainer_name_snapshot = booking.trainer_name;
    if (booking.location_snapshot === undefined && booking.shift_location) missing.location_snapshot = booking.shift_location;
    if (Object.keys(missing).length === 0) continue; // đã đủ → chạy lại lệnh không đổi gì
    await connection.collection('pt_bookings').updateOne({ _id: booking._id }, { $set: missing });
  }
}

// US-64-C04: booking tạo trước US-64 chưa có completion_revision.
// - COMPLETED: đã hoàn tất đúng một lần → revision 1; gói bị trừ buổi là gói booking đang tham chiếu (nếu chưa ghi).
// - BOOKED/CANCELLED: chưa hoàn tất lần nào → revision 0.
// Chỉ chọn booking CHƯA có completion_revision nên booking đã có giữ nguyên và chạy lại lệnh không đổi gì.
// Không đụng sessions_used, status, membership_id, version (US-64-F02: không tự chữa dữ liệu).
async function backfillCompletionSource(connection: Connection): Promise<void> {
  const bookings = connection.collection('pt_bookings');
  // Dạng update bằng pipeline ([{ $set }]) để đọc được field của chính document:
  // '$membership_id' là giá trị membership_id của booking đó; $ifNull giữ completion_membership_id nếu đã có.
  await bookings.updateMany(
    { status: 'COMPLETED', completion_revision: { $exists: false } },
    [{ $set: { completion_revision: 1, completion_membership_id: { $ifNull: ['$completion_membership_id', '$membership_id'] } } }],
  );
  await bookings.updateMany(
    { status: { $ne: 'COMPLETED' }, completion_revision: { $exists: false } },
    { $set: { completion_revision: 0 } },
  );
}

// Lỗi cho người vận hành: loại vi phạm và id document để đối chiếu, sửa tay rồi chạy lại lệnh. Không tự sửa dữ liệu.
function scheduleDataInvalid(kind: string, id: string) {
  return new Error(`SCHEDULE_DATA_INVALID: ${kind}/${id}`);
}
