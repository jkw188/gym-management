// Tầng dữ liệu – migration vận hành (US-28 bước 1): chạy trong lệnh ensure-indexes, TRƯỚC khi mở writer lịch.
// Kiểm dữ liệu lịch cũ, tạo index pt_bookings, đặt version=0 cho booking cũ, rồi mới tạo khóa schedule_guards global.
import { Long } from 'mongodb';
import { Connection } from 'mongoose';
import { PtBookingSchema } from '../bookings/schemas/pt-booking.schema';
import { SCHEDULE_GUARD_ID } from '../../infrastructure/transaction/data-guards.service';

// Booking còn chiếm giờ của PT (CANCELLED thì không).
const ACTIVE_STATUSES = ['BOOKED', 'COMPLETED'];

export async function ensureSchedulingIntegrity(connection: Connection): Promise<void> {
  // 1. Kiểm trước, chưa sửa gì: có vi phạm thì dừng ngay, dữ liệu và guard giữ nguyên.
  await assertNoTrainerOverlap(connection);
  await assertQuotaNotExceeded(connection);

  // 2. Index theo spec mục 3 (khai báo trong PtBookingSchema để chỉ có một nơi định nghĩa).
  await connection.model('PtBooking', PtBookingSchema).createIndexes();

  // 3. Booking tạo trước US-28 chưa có version → đặt 0; booking đã có version giữ nguyên.
  await connection.collection('pt_bookings').updateMany({ version: { $exists: false } }, { $set: { version: 0 } });

  // 4. US-28-G01: tạo guard sau cùng, chỉ khi chưa có ($setOnInsert) → chạy lại không đổi revision đang có.
  await connection.db!.collection<{ _id: string; revision: Long }>('schedule_guards').updateOne(
    { _id: SCHEDULE_GUARD_ID }, { $setOnInsert: { revision: Long.ZERO } }, { upsert: true });
}

// Hai booking BOOKED/COMPLETED cùng PT không được giao nhau.
// Sắp xếp theo PT rồi giờ bắt đầu: với mỗi PT chỉ cần nhớ giờ kết thúc muộn nhất đã gặp;
// booking tiếp theo bắt đầu TRƯỚC giờ đó là giao nhau (bắt đầu đúng bằng là tiếp giáp, hợp lệ).
async function assertNoTrainerOverlap(connection: Connection): Promise<void> {
  const cursor = connection.collection('pt_bookings')
    .find({ status: { $in: ACTIVE_STATUSES } }, { projection: { trainer_id: 1, start_at: 1, end_at: 1 } })
    .sort({ trainer_id: 1, start_at: 1 });
  let currentTrainer = '';
  let latestEnd = 0;
  for await (const booking of cursor) {
    const trainer = String(booking.trainer_id);
    if (trainer !== currentTrainer) {
      currentTrainer = trainer;
      latestEnd = 0;
    }
    if (booking.start_at.getTime() < latestEnd) throw scheduleDataInvalid('trainer_overlap', String(booking._id));
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

// Lỗi cho người vận hành: loại vi phạm và id document để đối chiếu, sửa tay rồi chạy lại lệnh. Không tự sửa dữ liệu.
function scheduleDataInvalid(kind: string, id: string) {
  return new Error(`SCHEDULE_DATA_INVALID: ${kind}/${id}`);
}
