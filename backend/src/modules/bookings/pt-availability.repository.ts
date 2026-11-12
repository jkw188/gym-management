// Tầng dữ liệu (US-27 bước 1): nơi duy nhất đọc hồ sơ PT (trainers → accounts → roles) và giờ bận trong pt_bookings.
// Chỉ đọc, không ghi gì: xem slot không giữ chỗ (US-27-TC09). trainers thuộc US-23 nên đọc thẳng collection.
// Trạng thái nào là "khả dụng", "bận" do AvailabilityService quyết định và truyền vào; repository chỉ chạy truy vấn.
import { Injectable } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, Types } from 'mongoose';
import { AvailableTrainerRow, BusyTime, TrainerAvailabilityRule } from './pt-availability.types';
import { PtBooking, PtBookingStatus } from './schemas/pt-booking.schema';

// Thoát mọi ký tự đặc biệt để chuỗi người dùng gõ chỉ được so khớp như chữ thường (spec: không dùng regex trực tiếp từ người dùng).
function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Lọc PT theo điều kiện service đưa vào: trạng thái hồ sơ, trạng thái account, mã role. Chỉ lấy id, tên, chuyên môn.
function trainerStages(trainerMatch: Record<string, unknown>, rule: TrainerAvailabilityRule) {
  return [
    { $match: { ...trainerMatch, status: rule.trainerStatus } },
    { $lookup: { from: 'accounts', localField: 'account_id', foreignField: '_id', as: 'account' } },
    { $unwind: '$account' },
    { $match: { 'account.status': rule.accountStatus } },
    { $lookup: { from: 'roles', localField: 'account.role_id', foreignField: '_id', as: 'role' } },
    { $unwind: '$role' },
    { $match: { 'role.code': rule.roleCode } },
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

  // Danh sách PT theo điều kiện, lọc tên (không phân biệt hoa thường), sắp tên rồi id ASC, có phân trang.
  async listTrainers(rule: TrainerAvailabilityRule, q: string | undefined, page: number, limit: number) {
    const stages: object[] = trainerStages({}, rule);
    if (q) stages.push({ $match: { display_name: { $regex: escapeRegex(q), $options: 'i' } } });
    stages.push(
      { $sort: { display_name: 1, _id: 1 } },
      // $facet chạy hai nhánh trên cùng kết quả: một nhánh lấy trang, một nhánh đếm tổng.
      { $facet: { items: [{ $skip: (page - 1) * limit }, { $limit: limit }], total: [{ $count: 'count' }] } },
    );
    // collation 'vi': so tên theo thứ tự chữ cái tiếng Việt (Ánh, Đức đứng đúng chỗ, không bị đẩy ra sau Z).
    const [result] = await this.connection.db!.collection('trainers')
      .aggregate<{ items: AvailableTrainerRow[]; total: { count: number }[] }>(stages, { maxTimeMS: 5000, collation: { locale: 'vi' } })
      .toArray();
    return { items: result.items, total: result.total[0]?.count ?? 0 };
  }

  // Một PT nếu thỏa điều kiện, ngược lại null.
  async findTrainer(trainerId: Types.ObjectId, rule: TrainerAvailabilityRule): Promise<AvailableTrainerRow | null> {
    const [row] = await this.connection.db!.collection('trainers')
      .aggregate<AvailableTrainerRow>(trainerStages({ _id: trainerId }, rule), { maxTimeMS: 5000 }).toArray();
    return row ?? null;
  }

  // Giờ các buổi của một PT có trạng thái trong statuses và giao [from, to). Dùng index trainer_id,status,start_at,end_at.
  findBusyTimesOfTrainer(trainerId: Types.ObjectId, statuses: PtBookingStatus[], from: Date, to: Date): Promise<BusyTime[]> {
    return this.bookings.find(
      { trainer_id: trainerId, status: { $in: statuses }, start_at: { $lt: to }, end_at: { $gt: from } },
      { _id: 0, start_at: 1, end_at: 1 },
    ).maxTimeMS(5000).lean<BusyTime[]>().exec();
  }

  // Giờ các buổi của một Member trên MỌI PT và mọi membership, trạng thái trong statuses, giao [from, to).
  findBusyTimesOfMember(memberId: Types.ObjectId, statuses: PtBookingStatus[], from: Date, to: Date): Promise<BusyTime[]> {
    return this.bookings.find(
      { member_id: memberId, status: { $in: statuses }, start_at: { $lt: to }, end_at: { $gt: from } },
      { _id: 0, start_at: 1, end_at: 1 },
    ).maxTimeMS(5000).lean<BusyTime[]>().exec();
  }
}
