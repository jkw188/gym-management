// Tầng dữ liệu (US-65 bước 2): nơi duy nhất đọc/ghi trainer_reviews, kèm đọc hồ sơ hội viên và tên PT để chụp snapshot.
// Mọi hàm nhận session (tùy chọn) để lệnh gửi đọc lại dữ liệu trong CÙNG transaction sau khi giữ khóa (US-65-F05).
import { Injectable } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ClientSession } from 'mongodb';
import { Connection, Model, Types } from 'mongoose';
import { TrainerReview } from './schemas/trainer-review.schema';
import { NewTrainerReview, ReviewMember } from './review.types';

@Injectable()
export class ReviewRepository {
  constructor(
    @InjectModel('TrainerReview') private readonly reviews: Model<TrainerReview>,
    @InjectConnection() private readonly connection: Connection,
  ) {}

  // US-65-F01: account đang đăng nhập → hồ sơ hội viên đã liên kết (members.account_id); null nếu chưa liên kết.
  // Chỉ lấy id và tên, không lấy điện thoại/địa chỉ (US-65-TC08).
  findMemberOfAccount(accountId: Types.ObjectId, session?: ClientSession): Promise<ReviewMember | null> {
    return this.connection.db!.collection('members').findOne<ReviewMember>(
      { account_id: accountId }, { projection: { _id: 1, full_name: 1 }, session });
  }

  // US-65-F04: tên hiển thị của PT (trainers.account_id → accounts.full_name); undefined nếu không tìm thấy.
  async findTrainerName(trainerId: Types.ObjectId, session: ClientSession): Promise<string | undefined> {
    const trainer = await this.connection.db!.collection('trainers').findOne({ _id: trainerId }, { projection: { account_id: 1 }, session });
    if (!trainer?.account_id) return undefined;
    const account = await this.connection.db!.collection('accounts').findOne(
      { _id: trainer.account_id }, { projection: { full_name: 1 }, session });
    return (account?.full_name as string | undefined) ?? undefined;
  }

  // US-65-F03: đánh giá (nếu có) của một buổi; unique booking_id nên nhiều nhất một.
  findByBooking(bookingId: Types.ObjectId, session?: ClientSession): Promise<TrainerReview | null> {
    return this.reviews.findOne({ booking_id: bookingId }).session(session ?? null).lean<TrainerReview>().exec();
  }

  // US-65-TC01: tạo đánh giá trong session của transaction; schema kiểm rating Int32 1–5, comment ≤ 1000, snapshot ≤ 120.
  async insert(review: NewTrainerReview, session: ClientSession): Promise<TrainerReview> {
    const id = new Types.ObjectId();
    const [created] = await this.reviews.create([{
      _id: id,
      id,
      booking_id: review.bookingId,
      rating: review.rating,
      comment: review.comment,
      created_at: review.createdAt,
      trainer_id: review.trainerId,
      member_id: review.memberId,
      created_by: review.createdBy,
      trainer_name_snapshot: review.trainerName,
      member_display_name_snapshot: review.memberName,
    }], { session });
    return created.toObject();
  }
}
