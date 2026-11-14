// Tầng dữ liệu (US-65 bước 2, US-31 bước 1): nơi duy nhất đọc/ghi trainer_reviews, kèm đọc hồ sơ hội viên và tên PT để chụp snapshot.
// Mọi hàm ghi nhận session (tùy chọn) để lệnh gửi đọc lại dữ liệu trong CÙNG transaction sau khi giữ khóa (US-65-F05).
import { Injectable } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ClientSession } from 'mongodb';
import { Connection, Model, PipelineStage, Types } from 'mongoose';
import { TrainerReview } from './schemas/trainer-review.schema';
import { NewTrainerReview, ReviewMember, TrainerReviewFilter, TrainerReviewRow } from './review.types';

// US-31 mục 2: nối review sang buổi tập bằng booking_id VÀ kiểm buổi đó cũng do chính PT này dạy.
// Chỉ lấy 3 field giờ buổi; review không có buổi khớp bị $unwind bỏ đi (bước 4 bổ sung dataIssue cho nguồn mồ côi).
function bookingStages(trainerId: Types.ObjectId): PipelineStage[] {
  return [
    { $lookup: {
      from: 'pt_bookings',
      let: { bookingId: '$booking_id' },
      pipeline: [
        { $match: { $expr: { $eq: ['$_id', '$$bookingId'] }, trainer_id: trainerId } },
        { $project: { _id: 1, start_at: 1, end_at: 1 } },
      ],
      as: 'booking',
    } },
    { $unwind: '$booking' },
  ];
}

// US-31-F03: chỉ các field PT được xem; không lấy member_id, created_by, tên PT.
const TRAINER_VIEW_PROJECTION: PipelineStage = {
  $project: { _id: 1, rating: 1, comment: 1, created_at: 1, member_display_name_snapshot: 1, booking: 1 },
};

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

  // US-31-TC04: account đang đăng nhập → hồ sơ PT (trainers.account_id); null nếu chưa có hồ sơ PT.
  async findTrainerIdOfAccount(accountId: Types.ObjectId): Promise<Types.ObjectId | null> {
    const trainer = await this.connection.db!.collection('trainers').findOne({ account_id: accountId }, { projection: { _id: 1 } });
    return trainer ? (trainer._id as Types.ObjectId) : null;
  }

  // US-31-F01, F02: đánh giá của MỘT PT, lọc trainer_id và thời điểm gửi ngay trong truy vấn DB (dùng index
  // trainer_id, created_at, _id), sắp mới gửi trước rồi _id giảm dần.
  findTrainerReviews(filter: TrainerReviewFilter): Promise<TrainerReviewRow[]> {
    return this.reviews.aggregate<TrainerReviewRow>([
      { $match: { trainer_id: filter.trainerId, created_at: { $gte: filter.from, $lt: filter.to } } },
      { $sort: { created_at: -1, _id: -1 } },
      ...bookingStages(filter.trainerId),
      { $limit: filter.limit },
      TRAINER_VIEW_PROJECTION,
    ]).exec();
  }

  // US-31-TC01, TC02: một đánh giá theo id, CHỈ khi thuộc PT này; của PT khác hoặc không có → null.
  async findTrainerReviewById(trainerId: Types.ObjectId, reviewId: Types.ObjectId): Promise<TrainerReviewRow | null> {
    const [row] = await this.reviews.aggregate<TrainerReviewRow>([
      { $match: { _id: reviewId, trainer_id: trainerId } },
      ...bookingStages(trainerId),
      TRAINER_VIEW_PROJECTION,
    ]).exec();
    return row ?? null;
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
