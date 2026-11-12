// Tầng dữ liệu (US-30 bước 1–2): nơi duy nhất đọc MongoDB cho học viên của PT (danh sách, hồ sơ tối thiểu, lịch, gói liên quan).
// Luôn bắt đầu từ pt_bookings của chính PT: gom theo member_id (distinct) rồi mới nối members, lọc, sắp và phân trang.
import { Injectable } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, PipelineStage, Types } from 'mongoose';
import { PtBooking, PtBookingStatus } from '../bookings/schemas/pt-booking.schema';
import { TraineeBookingFilter, TraineeFilter, TraineeRelationFilter, TraineeRow } from './trainees.types';

// Kết quả $facet: một trang dòng + tổng số dòng khớp cùng điều kiện.
interface FacetPage<T> {
  items: T[];
  count: { total: number }[];
}

// US-30-TC08: thêm dấu \ trước mọi ký tự đặc biệt của regex để chuỗi người dùng nhập chỉ được hiểu là chữ thường (literal).
function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Bước phân trang dùng chung: cắt một trang và đếm tổng trong CÙNG một truy vấn (total cùng điều kiện với items).
function pageStage(page: number, limit: number): PipelineStage {
  return { $facet: { items: [{ $skip: (page - 1) * limit }, { $limit: limit }], count: [{ $count: 'total' }] } };
}

@Injectable()
export class TraineesRepository {
  constructor(
    @InjectModel('PtBooking') private readonly bookings: Model<PtBooking>,
    @InjectConnection() private readonly connection: Connection,
  ) {}

  // US-30-TC04: account đang đăng nhập → hồ sơ PT (trainers.account_id); null nếu chưa có hồ sơ PT.
  async findTrainerIdOfAccount(accountId: Types.ObjectId): Promise<Types.ObjectId | null> {
    const trainer = await this.connection.db!.collection('trainers').findOne({ account_id: accountId }, { projection: { _id: 1 } });
    return trainer ? (trainer._id as Types.ObjectId) : null;
  }

  // Các bước gom học viên theo luật service truyền xuống; memberId có thì chỉ xét một học viên (bước 2).
  // Danh sách và kiểm quan hệ từng học viên dùng CHUNG các bước này nên không thể lệch luật nhau.
  private relationStages(filter: TraineeRelationFilter, memberId?: Types.ObjectId): PipelineStage[] {
    const match: Record<string, unknown> = { trainer_id: filter.trainerId, status: { $in: filter.relationStatuses } };
    if (memberId) match.member_id = memberId;
    return [
      // 1. Chỉ booking của chính PT có trạng thái tạo quan hệ (dùng index trainer_id, status, member_id).
      { $match: match },
      // 2. Distinct: gom mọi buổi của một hội viên thành một dòng (US-30-TC01).
      //    $min/$max bỏ qua giá trị null, nên buổi không thỏa điều kiện không ảnh hưởng kết quả.
      { $group: {
        _id: '$member_id',
        related_booking_count: { $sum: 1 },
        // Buổi sắp tới sớm nhất, theo trạng thái và mốc giờ service truyền xuống.
        next_booking_at: { $min: { $cond: [
          { $and: [{ $eq: ['$status', filter.upcomingStatus] }, { $gte: ['$start_at', filter.upcomingFrom] }] }, '$start_at', null,
        ] } },
        // Lúc xác nhận của buổi hoàn tất gần nhất, theo trạng thái service truyền xuống.
        last_completed_at: { $max: { $cond: [{ $eq: ['$status', filter.completedStatus] }, '$completed_at', null] } },
      } },
      // 3. Nối members bằng _id, chỉ lấy mã và tên; không đọc phone/email/address (US-30-F02).
      { $lookup: { from: 'members', localField: '_id', foreignField: '_id', as: 'member',
        pipeline: [{ $project: { member_code: 1, full_name: 1 } }] } },
      { $unwind: '$member' },
      { $set: { member_code: '$member.member_code', full_name: '$member.full_name' } },
      { $unset: 'member' },
    ];
  }

  // US-30-TC01, TC02, TC05, TC08: một trang học viên của PT và tổng số học viên khớp điều kiện.
  async findTrainees(filter: TraineeFilter): Promise<{ rows: TraineeRow[]; total: number }> {
    const pipeline = this.relationStages(filter);
    // 4. Tìm kiếm chỉ trong tập học viên đã gom ở trên, không tra toàn bộ members (US-30-TC08).
    if (filter.search) {
      const literal = escapeRegex(filter.search);
      pipeline.push({ $match: { $or: [
        { full_name: { $regex: literal, $options: 'i' } },
        { member_code: { $regex: literal, $options: 'i' } },
      ] } });
    }
    // 5. Lọc còn / không còn buổi sắp tới (US-30-TC01).
    if (filter.hasUpcoming === true) pipeline.push({ $match: { next_booking_at: { $ne: null } } });
    if (filter.hasUpcoming === false) pipeline.push({ $match: { next_booking_at: null } });
    // 6. Sắp tên rồi id tăng dần, sau đó mới phân trang (distinct trước phân trang).
    pipeline.push({ $sort: { full_name: 1, _id: 1 } }, pageStage(filter.page, filter.limit));
    const [result] = await this.bookings.aggregate<FacetPage<TraineeRow>>(pipeline).option({ maxTimeMS: 5000 }).exec();
    return { rows: result.items, total: result.count[0]?.total ?? 0 };
  }

  // US-30 bước 2 (US-30-F04): quan hệ của PT với MỘT học viên, đọc lại ở mỗi request; null = không có quan hệ.
  async findTrainee(filter: TraineeRelationFilter, memberId: Types.ObjectId): Promise<TraineeRow | null> {
    const [row] = await this.bookings.aggregate<TraineeRow>(this.relationStages(filter, memberId)).option({ maxTimeMS: 5000 }).exec();
    return row ?? null;
  }

  // US-30-TC05: một trang buổi của học viên do chính PT dạy, sắp startAt rồi _id tăng dần.
  // Dùng index trainer_id, member_id, start_at, _id.
  async findBookingsPage(filter: TraineeBookingFilter, page: number, limit: number): Promise<{ rows: PtBooking[]; total: number }> {
    const [result] = await this.bookings.aggregate<FacetPage<PtBooking>>([
      { $match: {
        trainer_id: filter.trainerId, member_id: filter.memberId,
        status: { $in: filter.statuses }, start_at: { $gte: filter.from, $lt: filter.to },
      } },
      { $sort: { start_at: 1, _id: 1 } },
      pageStage(page, limit),
    ]).option({ maxTimeMS: 5000 }).exec();
    return { rows: result.items, total: result.count[0]?.total ?? 0 };
  }

  // US-30-TC07, TC10: một trang mã gói có booking (trạng thái service truyền) giữa học viên và chính PT, gói mới trước.
  // Distinct theo membership_id trước khi phân trang; membership_id của BOOKED đã theo gói mới sau nâng cấp.
  async findRelatedMembershipIds(
    trainerId: Types.ObjectId, memberId: Types.ObjectId, statuses: PtBookingStatus[], page: number, limit: number,
  ): Promise<{ ids: Types.ObjectId[]; total: number }> {
    const [result] = await this.bookings.aggregate<FacetPage<{ _id: Types.ObjectId }>>([
      { $match: { trainer_id: trainerId, member_id: memberId, status: { $in: statuses } } },
      { $group: { _id: '$membership_id' } },
      { $sort: { _id: -1 } },
      pageStage(page, limit),
    ]).option({ maxTimeMS: 5000 }).exec();
    return { ids: result.items.map(item => item._id), total: result.count[0]?.total ?? 0 };
  }
}
