// Tầng dữ liệu – migration vận hành (US-65 bước 1): chạy trong lệnh ensure-indexes, TRƯỚC khi mở API gửi đánh giá.
// Tạo index trainer_reviews và bổ sung owner/snapshot cho đánh giá cũ từ booking. Kiểm HẾT trước, có vi phạm thì dừng, không ghi gì.
import { ObjectId } from 'mongodb';
import { Connection } from 'mongoose';
import { TrainerReviewSchema } from './schemas/trainer-review.schema';

// Một đánh giá kèm dữ liệu tra được qua $lookup (xem loadReviews).
interface ReviewRow {
  _id: ObjectId;
  trainer_id?: ObjectId;
  member_id?: ObjectId;
  created_by?: ObjectId;
  trainer_name_snapshot?: string;
  member_display_name_snapshot?: string;
  booking_found: boolean; // có booking mà booking_id trỏ tới không
  booking_status?: string;
  booking_trainer_id?: ObjectId;
  booking_member_id?: ObjectId;
  member_account_id?: ObjectId; // members.account_id → người gửi (created_by)
  member_name?: string; // members.full_name → member_display_name_snapshot
  trainer_name?: string; // accounts.full_name của PT → trainer_name_snapshot
}

export async function ensureTrainerReviewsIntegrity(connection: Connection): Promise<void> {
  const reviews = await loadReviews(connection);

  // 1. Kiểm trước, chưa sửa gì: "không đoán khi mồ côi" (spec mục 2) → dừng, dữ liệu giữ nguyên.
  assertReviewsResolvable(reviews);

  // 2. Index theo spec mục 2 (khai báo trong TrainerReviewSchema để chỉ có một nơi định nghĩa).
  await connection.model('TrainerReview', TrainerReviewSchema).createIndexes();

  // 3. US-65-F04: điền owner/snapshot còn thiếu.
  await backfillReviews(connection, reviews);
}

// Đọc mọi đánh giá một lần, kèm booking → member và booking → trainer → account của PT.
async function loadReviews(connection: Connection): Promise<ReviewRow[]> {
  return connection.collection('trainer_reviews').aggregate<ReviewRow>([
    { $lookup: { from: 'pt_bookings', localField: 'booking_id', foreignField: '_id', as: 'booking' } },
    { $lookup: { from: 'members', localField: 'booking.member_id', foreignField: '_id', as: 'member' } },
    { $lookup: { from: 'trainers', localField: 'booking.trainer_id', foreignField: '_id', as: 'trainer' } },
    { $lookup: { from: 'accounts', localField: 'trainer.account_id', foreignField: '_id', as: 'trainer_account' } },
    { $project: {
      trainer_id: 1, member_id: 1, created_by: 1, trainer_name_snapshot: 1, member_display_name_snapshot: 1,
      booking_found: { $gt: [{ $size: '$booking' }, 0] },
      booking_status: { $first: '$booking.status' },
      booking_trainer_id: { $first: '$booking.trainer_id' },
      booking_member_id: { $first: '$booking.member_id' },
      member_account_id: { $first: '$member.account_id' },
      member_name: { $first: '$member.full_name' },
      trainer_name: { $first: '$trainer_account.full_name' },
    } },
  ]).toArray();
}

// US-65-F01: đánh giá hợp lệ phải thuộc booking COMPLETED có chủ Member đã liên kết tài khoản.
// Field owner đã có thì phải khớp booking; không khớp thì không ghi đè, để người vận hành đối chiếu.
function assertReviewsResolvable(reviews: ReviewRow[]): void {
  for (const review of reviews) {
    const id = String(review._id);
    if (!review.booking_found) throw reviewDataInvalid('orphan_review', id);
    // US-65-TC04: BOOKED/CANCELLED chưa thể có đánh giá.
    if (review.booking_status !== 'COMPLETED') throw reviewDataInvalid('booking_not_completed', id);
    if (!review.booking_member_id || !review.booking_trainer_id) throw reviewDataInvalid('booking_owner_missing', id);
    if (!review.member_account_id) throw reviewDataInvalid('member_account_missing', id);
    if (review.trainer_id && !review.trainer_id.equals(review.booking_trainer_id)) throw reviewDataInvalid('trainer_mismatch', id);
    if (review.member_id && !review.member_id.equals(review.booking_member_id)) throw reviewDataInvalid('member_mismatch', id);
    if (review.created_by && !review.created_by.equals(review.member_account_id)) throw reviewDataInvalid('author_mismatch', id);
  }
}

// US-65-F04: chỉ ghi field CÒN THIẾU. Snapshot đã có giữ nguyên (là tên lúc gửi); không tìm thấy tên thì để trống.
// Không đụng rating, comment, created_at; không copy phone/email/address (US-65-TC08).
async function backfillReviews(connection: Connection, reviews: ReviewRow[]): Promise<void> {
  for (const review of reviews) {
    const missing: Record<string, unknown> = {};
    if (!review.trainer_id) missing.trainer_id = review.booking_trainer_id;
    if (!review.member_id) missing.member_id = review.booking_member_id;
    if (!review.created_by) missing.created_by = review.member_account_id;
    if (review.trainer_name_snapshot === undefined && review.trainer_name) missing.trainer_name_snapshot = review.trainer_name;
    if (review.member_display_name_snapshot === undefined && review.member_name) {
      missing.member_display_name_snapshot = review.member_name;
    }
    if (Object.keys(missing).length === 0) continue; // đã đủ → chạy lại lệnh không đổi gì
    await connection.collection('trainer_reviews').updateOne({ _id: review._id }, { $set: missing });
  }
}

// Lỗi cho người vận hành: loại vi phạm và id đánh giá để đối chiếu, sửa tay rồi chạy lại lệnh. Không tự sửa dữ liệu.
function reviewDataInvalid(kind: string, id: string) {
  return new Error(`REVIEW_DATA_INVALID: ${kind}/${id}`);
}
