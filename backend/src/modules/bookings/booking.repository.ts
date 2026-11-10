// Tầng dữ liệu (US-28 bước 3): nơi duy nhất đọc/ghi MongoDB cho lệnh Member đặt slot PT.
// Mọi hàm nhận session của transaction để đọc lại dữ liệu SAU khi đã giữ khóa lịch và khóa member (US-28-G04).
// Trạng thái nào là "bận", "giữ quota" do BookingService quyết định và truyền vào; repository chỉ chạy truy vấn.
import { Injectable } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ClientSession } from 'mongodb';
import { Connection, Model, Types } from 'mongoose';
import { TimeInterval } from '../scheduling/interval.policy';
import { Membership } from '../memberships/schemas/membership.schema';
import { ServiceSale } from '../memberships/schemas/service-sale.schema';
import { NewPtBooking, TrainerForBooking, TransactionForBooking } from './booking.types';
import { PtBooking, PtBookingStatus } from './schemas/pt-booking.schema';

// Điều kiện "giao khoảng [startAt, endAt)": start < endAt và end > startAt (tiếp giáp không tính, US-28-TC14).
function overlapCondition(interval: TimeInterval) {
  return { start_at: { $lt: interval.endAt }, end_at: { $gt: interval.startAt } };
}

@Injectable()
export class BookingRepository {
  constructor(
    @InjectModel('PtBooking') private readonly bookings: Model<PtBooking>,
    @InjectConnection() private readonly connection: Connection,
  ) {}

  // US-28-F01: account đang đăng nhập → hồ sơ member đã liên kết; null nếu chưa liên kết.
  async findMemberIdOfAccount(accountId: Types.ObjectId, session: ClientSession): Promise<Types.ObjectId | null> {
    const member = await this.connection.db!.collection('members').findOne({ account_id: accountId }, { projection: { _id: 1 }, session });
    return member ? (member._id as Types.ObjectId) : null;
  }

  findMembership(id: Types.ObjectId, session: ClientSession): Promise<Membership | null> {
    return this.connection.db!.collection<Membership>('memberships').findOne({ _id: id }, { session });
  }

  // Chủ sở hữu gói đi qua sale (sale có member_id), giống US-17: sale của người khác coi như không có.
  findOwnSale(memberId: Types.ObjectId, saleId: Types.ObjectId, session: ClientSession): Promise<ServiceSale | null> {
    return this.connection.db!.collection<ServiceSale>('service_sales').findOne({ _id: saleId, member_id: memberId }, { session });
  }

  findOwnTransaction(memberId: Types.ObjectId, transactionId: Types.ObjectId, session: ClientSession): Promise<TransactionForBooking | null> {
    return this.connection.db!.collection('transactions').findOne<TransactionForBooking>(
      { _id: transactionId, member_id: memberId }, { projection: { _id: 0, kind: 1, status: 1 }, session });
  }

  // US-28-F03: số buổi của gói có trạng thái giữ quota (service truyền BOOKED), kể cả buổi đã qua giờ.
  countBookingsOfMembership(membershipId: Types.ObjectId, status: PtBookingStatus, session: ClientSession): Promise<number> {
    return this.bookings.countDocuments({ membership_id: membershipId, status }).session(session).exec();
  }

  // Hồ sơ PT kèm trạng thái account, role và tên hiển thị (trainers → accounts → roles); null nếu không có hồ sơ/account.
  async findTrainer(trainerId: Types.ObjectId, session: ClientSession): Promise<TrainerForBooking | null> {
    const [row] = await this.connection.db!.collection('trainers').aggregate<TrainerForBooking>([
      { $match: { _id: trainerId } },
      { $lookup: { from: 'accounts', localField: 'account_id', foreignField: '_id', as: 'account' } },
      { $unwind: '$account' },
      { $lookup: { from: 'roles', localField: 'account.role_id', foreignField: '_id', as: 'role' } },
      { $unwind: { path: '$role', preserveNullAndEmptyArrays: true } },
      { $project: { _id: 1, status: 1, account_status: '$account.status', role_code: '$role.code', full_name: '$account.full_name' } },
    ], { session }).toArray();
    return row ?? null;
  }

  // US-28-F04: PT đã có buổi (trạng thái trong statuses) giao giờ này chưa. Dùng index trainer_id,status,start_at,end_at.
  async trainerHasBooking(trainerId: Types.ObjectId, statuses: PtBookingStatus[], interval: TimeInterval, session: ClientSession): Promise<boolean> {
    const found = await this.bookings.exists({ trainer_id: trainerId, status: { $in: statuses }, ...overlapCondition(interval) }).session(session).exec();
    return found !== null;
  }

  // US-28-F04: chính Member đã có buổi giao giờ này trên MỌI PT và mọi membership chưa. Dùng index member_id,status,start_at,end_at.
  async memberHasBooking(memberId: Types.ObjectId, statuses: PtBookingStatus[], interval: TimeInterval, session: ClientSession): Promise<boolean> {
    const found = await this.bookings.exists({ member_id: memberId, status: { $in: statuses }, ...overlapCondition(interval) }).session(session).exec();
    return found !== null;
  }

  // US-28-F04: PT có lớp (trạng thái do service truyền, PUBLISHED) giao giờ này không. public_sessions thuộc US-66.
  async trainerHasClass(trainerId: Types.ObjectId, status: string, interval: TimeInterval, session: ClientSession): Promise<boolean> {
    const found = await this.connection.db!.collection('public_sessions')
      .findOne({ trainer_id: trainerId, status, ...overlapCondition(interval) }, { projection: { _id: 1 }, session });
    return found !== null;
  }

  // US-28-TC01: tạo booking BOOKED version 0 (schema Mongoose kiểm field bắt buộc, độ dài snapshot ≤ 120).
  async insertBooking(booking: NewPtBooking, session: ClientSession): Promise<PtBooking> {
    const id = new Types.ObjectId();
    const [created] = await this.bookings.create([{
      _id: id,
      id,
      member_id: booking.memberId,
      membership_id: booking.membershipId,
      trainer_id: booking.trainerId,
      shift_id: booking.shiftId,
      start_at: booking.startAt,
      end_at: booking.endAt,
      status: 'BOOKED',
      version: 0,
      trainer_name_snapshot: booking.trainerName,
      location_snapshot: booking.location,
      request_key: booking.requestKey,
      created_by: booking.createdBy,
      created_at: booking.now,
      updated_at: booking.now,
    }], { session });
    return created.toObject();
  }
}
