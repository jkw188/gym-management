// Tầng dữ liệu (US-64 bước 4): nơi duy nhất đọc pt_bookings cho danh sách buổi dạy của PT.
// Nối members để lấy tên hội viên; chỉ lấy field cần hiển thị, không đọc số điện thoại hay tiền.
import { Injectable } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, Types } from 'mongoose';
import { PtBooking } from './schemas/pt-booking.schema';
import { TrainerBookingFilter, TrainerBookingRow } from './trainer-bookings.types';

@Injectable()
export class TrainerBookingsRepository {
  constructor(
    @InjectModel('PtBooking') private readonly bookings: Model<PtBooking>,
    @InjectConnection() private readonly connection: Connection,
  ) {}

  // US-64-F01: account đang đăng nhập → hồ sơ PT (trainers.account_id); null nếu account chưa có hồ sơ PT.
  async findTrainerIdOfAccount(accountId: Types.ObjectId): Promise<Types.ObjectId | null> {
    const trainer = await this.connection.db!.collection('trainers').findOne({ account_id: accountId }, { projection: { _id: 1 } });
    return trainer ? (trainer._id as Types.ObjectId) : null;
  }

  // US-64-TC15: buổi của một PT có giờ bắt đầu trong [from, to), sắp startAt rồi _id tăng dần.
  // Dùng index trainer_id, status, start_at, end_at (US-27).
  findForTrainer(filter: TrainerBookingFilter): Promise<TrainerBookingRow[]> {
    const condition: Record<string, unknown> = { trainer_id: filter.trainerId, start_at: { $gte: filter.from, $lt: filter.to } };
    if (filter.status) condition.status = filter.status;
    return this.bookings.aggregate<TrainerBookingRow>([
      { $match: condition },
      { $sort: { start_at: 1, _id: 1 } },
      { $lookup: { from: 'members', localField: 'member_id', foreignField: '_id', as: 'member' } },
      { $set: { member_name: { $first: '$member.full_name' } } },
      { $unset: 'member' },
    ]).option({ maxTimeMS: 5000 }).exec();
  }
}
