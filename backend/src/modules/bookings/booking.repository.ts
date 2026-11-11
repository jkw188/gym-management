// Tầng dữ liệu (US-28 bước 3): nơi duy nhất đọc/ghi MongoDB cho lệnh Member đặt slot PT.
// Mọi hàm nhận session của transaction để đọc lại dữ liệu SAU khi đã giữ khóa lịch và khóa member (US-28-G04).
// Trạng thái nào là "bận", "giữ quota" do BookingService quyết định và truyền vào; repository chỉ chạy truy vấn.
// US-29 bước 1: thêm đọc booking theo id và ghi hủy có điều kiện (CAS) cho CancelBookingService.
// US-29 bước 2: thêm ghi audit booking_events và tìm account người nhận thông báo hủy (Member, PT).
import { Injectable } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ClientSession } from 'mongodb';
import { Connection, Model, Types } from 'mongoose';
import { TimeInterval } from '../scheduling/interval.policy';
import { Membership } from '../memberships/schemas/membership.schema';
import { ServiceSale } from '../memberships/schemas/service-sale.schema';
import { CancelPtBookingChange, NewBookingEvent, NewPtBooking, TrainerForBooking, TransactionForBooking } from './booking.types';
import { BookingEvent } from './schemas/booking-event.schema';
import { PtBooking, PtBookingStatus } from './schemas/pt-booking.schema';

// Điều kiện "giao khoảng [startAt, endAt)": start < endAt và end > startAt (tiếp giáp không tính, US-28-TC14).
function overlapCondition(interval: TimeInterval) {
  return { start_at: { $lt: interval.endAt }, end_at: { $gt: interval.startAt } };
}

@Injectable()
export class BookingRepository {
  constructor(
    @InjectModel('PtBooking') private readonly bookings: Model<PtBooking>,
    @InjectModel('BookingEvent') private readonly events: Model<BookingEvent>,
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
      { $project: { _id: 1, account_id: 1, status: 1, account_status: '$account.status', role_code: '$role.code', full_name: '$account.full_name' } },
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

  // US-29-F04: đọc booking mới nhất trong session của transaction; null nếu không tồn tại.
  findBookingById(id: Types.ObjectId, session: ClientSession): Promise<PtBooking | null> {
    return this.bookings.findById(id).session(session).lean<PtBooking>().exec();
  }

  // US-29-F03, F04: CAS – chỉ ghi khi booking VẪN đúng trạng thái và version mà service vừa kiểm.
  // Thành công trả booking sau khi ghi (version+1); null nếu booking đã bị đổi trước (service báo VERSION_CONFLICT).
  // Không DELETE, không đụng member_id/membership_id hay memberships: reserved = số buổi BOOKED nên tự giảm 1.
  cancelBooking(change: CancelPtBookingChange, session: ClientSession): Promise<PtBooking | null> {
    return this.bookings.findOneAndUpdate(
      { _id: change.bookingId, status: change.fromStatus, version: change.version },
      {
        $set: {
          status: change.toStatus,
          cancelled_at: change.now,
          cancelled_by: change.cancelledBy,
          cancellation_reason: change.reason,
          updated_at: change.now,
        },
        $inc: { version: 1 },
      },
      // returnDocument 'after' → trả document SAU khi cập nhật.
      { returnDocument: 'after', session },
    ).lean<PtBooking>().exec();
  }

  // US-29-F05, US-29-TC05: ghi một dòng audit trong CÙNG session với lệnh hủy; schema kiểm field bắt buộc và enum.
  async insertBookingEvent(event: NewBookingEvent, session: ClientSession): Promise<void> {
    await this.events.create([{
      booking_id: event.bookingId,
      member_id: event.memberId,
      membership_id: event.membershipId,
      actor_id: event.actorId,
      actor_role: event.actorRole,
      action: event.action,
      reason: event.reason,
      occurred_at: event.occurredAt,
      before_status: event.beforeStatus,
      after_status: event.afterStatus,
      request_key: event.requestKey,
    }], { session });
  }

  // US-29-TC08: account đang liên kết với hồ sơ member (kể cả account bị khóa); null nếu member chưa liên kết.
  async findAccountIdOfMember(memberId: Types.ObjectId, session: ClientSession): Promise<Types.ObjectId | null> {
    const member = await this.connection.db!.collection('members').findOne({ _id: memberId }, { projection: { account_id: 1 }, session });
    return (member?.account_id as Types.ObjectId | undefined) ?? null;
  }

  // US-29-TC08: account của PT (kể cả account bị khóa, trainer INACTIVE); null nếu không có hồ sơ PT.
  async findAccountIdOfTrainer(trainerId: Types.ObjectId, session: ClientSession): Promise<Types.ObjectId | null> {
    const trainer = await this.connection.db!.collection('trainers').findOne({ _id: trainerId }, { projection: { account_id: 1 }, session });
    return (trainer?.account_id as Types.ObjectId | undefined) ?? null;
  }
}
