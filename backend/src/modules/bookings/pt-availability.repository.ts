// Tầng dữ liệu (US-27 bước 1): nơi duy nhất đọc hồ sơ PT khả dụng (trainers → accounts → roles) và giờ bận trong pt_bookings.
// Chỉ đọc, không ghi gì: xem slot không giữ chỗ (US-27-TC09). trainers thuộc US-23 nên đọc thẳng collection.
import { Injectable } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, Types } from 'mongoose';
import { AvailableTrainerRow, BusyTime } from './pt-availability.types';
import { PtBooking, PtBookingStatus } from './schemas/pt-booking.schema';

// US-27-F03: BOOKED và COMPLETED đều là giờ đã dùng; CANCELLED không chặn.
const BUSY_STATUSES: PtBookingStatus[] = ['BOOKED', 'COMPLETED'];

// Thoát mọi ký tự đặc biệt để chuỗi người dùng gõ chỉ được so khớp như chữ thường (spec: không dùng regex trực tiếp từ người dùng).
function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// US-27-F01, US-27-TC02: PT khả dụng = hồ sơ ACTIVE + account ACTIVE + role TRAINER. Chỉ lấy id, tên, chuyên môn.
function availableTrainerStages(trainerMatch: Record<string, unknown>) {
  return [
    { $match: { ...trainerMatch, status: 'ACTIVE' } },
    { $lookup: { from: 'accounts', localField: 'account_id', foreignField: '_id', as: 'account' } },
    { $unwind: '$account' },
    { $match: { 'account.status': 'ACTIVE' } },
    { $lookup: { from: 'roles', localField: 'account.role_id', foreignField: '_id', as: 'role' } },
    { $unwind: '$role' },
    { $match: { 'role.code': 'TRAINER' } },
    // Không trả account_id, phone, email (US-27-F01).
    { $project: { _id: 1, display_name: '$account.full_name', specialty: 1 } },
  ];
}

@Injectable()
export class PtAvailabilityRepository {
  constructor(
    @InjectModel('PtBooking') private readonly bookings: Model<PtBooking>,
    @InjectConnection() private readonly connection: Connection,
  ) {}

  // Danh mục PT khả dụng, lọc tên (không phân biệt hoa thường), sắp tên rồi id ASC, có phân trang.
  async listAvailableTrainers(q: string | undefined, page: number, limit: number) {
    const stages: object[] = availableTrainerStages({});
    if (q) stages.push({ $match: { display_name: { $regex: escapeRegex(q), $options: 'i' } } });
    stages.push(
      { $sort: { display_name: 1, _id: 1 } },
      // $facet chạy hai nhánh trên cùng kết quả: một nhánh lấy trang, một nhánh đếm tổng.
      { $facet: { items: [{ $skip: (page - 1) * limit }, { $limit: limit }], total: [{ $count: 'count' }] } },
    );
    const [result] = await this.connection.db!.collection('trainers')
      .aggregate<{ items: AvailableTrainerRow[]; total: { count: number }[] }>(stages, { maxTimeMS: 5000 }).toArray();
    return { items: result.items, total: result.total[0]?.count ?? 0 };
  }

  // Một PT nếu còn khả dụng, ngược lại null (service trả 404 TRAINER_NOT_AVAILABLE).
  async findAvailableTrainer(trainerId: Types.ObjectId): Promise<AvailableTrainerRow | null> {
    const [row] = await this.connection.db!.collection('trainers')
      .aggregate<AvailableTrainerRow>(availableTrainerStages({ _id: trainerId }), { maxTimeMS: 5000 }).toArray();
    return row ?? null;
  }

  // US-27-F03, US-27-TC04: giờ các buổi BOOKED/COMPLETED của một PT giao [from, to). Dùng index trainer_id,status,start_at,end_at.
  findBusyTimesOfTrainer(trainerId: Types.ObjectId, from: Date, to: Date): Promise<BusyTime[]> {
    return this.bookings.find(
      { trainer_id: trainerId, status: { $in: BUSY_STATUSES }, start_at: { $lt: to }, end_at: { $gt: from } },
      { _id: 0, start_at: 1, end_at: 1 },
    ).maxTimeMS(5000).lean<BusyTime[]>().exec();
  }

  // US-27-F04, US-27-TC04: giờ các buổi BOOKED/COMPLETED của chính Member trên MỌI PT và mọi membership.
  findBusyTimesOfMember(memberId: Types.ObjectId, from: Date, to: Date): Promise<BusyTime[]> {
    return this.bookings.find(
      { member_id: memberId, status: { $in: BUSY_STATUSES }, start_at: { $lt: to }, end_at: { $gt: from } },
      { _id: 0, start_at: 1, end_at: 1 },
    ).maxTimeMS(5000).lean<BusyTime[]>().exec();
  }
}
