// Tầng dữ liệu (US-30 bước 1): nơi duy nhất đọc MongoDB cho danh sách học viên của PT.
// Bắt đầu từ pt_bookings của chính PT, gom theo member_id (distinct) rồi mới nối members, lọc, sắp và phân trang.
import { Injectable } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, PipelineStage, Types } from 'mongoose';
import { PtBooking } from '../bookings/schemas/pt-booking.schema';
import { TraineeFilter, TraineeRow } from './trainees.types';

// Kết quả $facet: một trang dòng + tổng số member khớp cùng điều kiện.
interface TraineePage {
  items: TraineeRow[];
  count: { total: number }[];
}

// US-30-TC08: thêm dấu \ trước mọi ký tự đặc biệt của regex để chuỗi người dùng nhập chỉ được hiểu là chữ thường (literal).
function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

  // US-30-TC01, TC02, TC05, TC08: một trang học viên của PT và tổng số học viên khớp điều kiện.
  async findTrainees(filter: TraineeFilter): Promise<{ rows: TraineeRow[]; total: number }> {
    const pipeline: PipelineStage[] = [
      // 1. Chỉ booking của chính PT có trạng thái tạo quan hệ (dùng index trainer_id, status, member_id).
      { $match: { trainer_id: filter.trainerId, status: { $in: filter.relationStatuses } } },
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
    // 6. Sắp tên rồi id tăng dần, sau đó mới phân trang; total đếm cùng điều kiện (distinct trước phân trang).
    pipeline.push(
      { $sort: { full_name: 1, _id: 1 } },
      { $facet: {
        items: [{ $skip: (filter.page - 1) * filter.limit }, { $limit: filter.limit }],
        count: [{ $count: 'total' }],
      } },
    );
    const [result] = await this.bookings.aggregate<TraineePage>(pipeline).option({ maxTimeMS: 5000 }).exec();
    return { rows: result.items, total: result.count[0]?.total ?? 0 };
  }
}
