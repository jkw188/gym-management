// Tầng dữ liệu (US-29 bước 3): nơi duy nhất đọc pt_bookings cho màn tra cứu hỗ trợ của Staff/Admin.
// Nối members để lấy mã và tên Member; chỉ lấy các field cần hiển thị, không đọc số điện thoại hay tiền.
// US-64 bước 3: thêm đọc lịch sử booking_events và nguồn quota (memberships, service_sales) cho chi tiết Admin.
import { Injectable } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, PipelineStage, Types } from 'mongoose';
import { BookingEvent } from './schemas/booking-event.schema';
import { PtBooking } from './schemas/pt-booking.schema';
import { SupportBookingFilter, SupportPtBookingRow } from './support-pt-bookings.types';

// Buổi có giờ bắt đầu trong [from, to) và khớp các điều kiện tùy chọn đã gửi.
function supportCondition(filter: SupportBookingFilter): Record<string, unknown> {
  const condition: Record<string, unknown> = { start_at: { $gte: filter.from, $lt: filter.to } };
  if (filter.memberId) condition.member_id = filter.memberId;
  if (filter.trainerId) condition.trainer_id = filter.trainerId;
  if (filter.status) condition.status = filter.status;
  return condition;
}

// Nối hồ sơ member để có member_code và full_name; bỏ mảng tạm "member" sau khi lấy xong.
const WITH_MEMBER: PipelineStage[] = [
  { $lookup: { from: 'members', localField: 'member_id', foreignField: '_id', as: 'member' } },
  { $set: { member_code: { $first: '$member.member_code' }, member_name: { $first: '$member.full_name' } } },
  { $unset: 'member' },
];

@Injectable()
export class SupportPtBookingsRepository {
  constructor(
    @InjectModel('PtBooking') private readonly bookings: Model<PtBooking>,
    @InjectModel('BookingEvent') private readonly events: Model<BookingEvent>,
    @InjectConnection() private readonly connection: Connection,
  ) {}

  // Một trang, sắp startAt ASC rồi _id ASC để phân trang không rơi hay trùng buổi cùng giờ (spec mục 2).
  findPage(filter: SupportBookingFilter, skip: number, limit: number): Promise<SupportPtBookingRow[]> {
    return this.bookings.aggregate<SupportPtBookingRow>([
      { $match: supportCondition(filter) },
      { $sort: { start_at: 1, _id: 1 } },
      { $skip: skip },
      { $limit: limit },
      ...WITH_MEMBER,
    ]).option({ maxTimeMS: 5000 }).exec();
  }

  count(filter: SupportBookingFilter): Promise<number> {
    return this.bookings.countDocuments(supportCondition(filter)).maxTimeMS(5000).exec();
  }

  // US-29-TC05: chi tiết một buổi kèm mã/tên Member; null nếu không tồn tại.
  async findById(id: Types.ObjectId): Promise<SupportPtBookingRow | null> {
    const [row] = await this.bookings.aggregate<SupportPtBookingRow>([{ $match: { _id: id } }, ...WITH_MEMBER])
      .option({ maxTimeMS: 5000 }).exec();
    return row ?? null;
  }

  // US-64-C04: mọi dòng audit của một buổi theo thứ tự xảy ra (dùng index booking_id + occurred_at).
  findEvents(bookingId: Types.ObjectId): Promise<BookingEvent[]> {
    return this.events.find({ booking_id: bookingId }).sort({ occurred_at: 1, _id: 1 }).maxTimeMS(5000).lean<BookingEvent[]>().exec();
  }

  // Spec mục 3: sessions_used của gói và sessions_snapshot của sale; field nào không có thì null.
  async findQuotaSource(membershipId: Types.ObjectId): Promise<{ used: number | null; quota: number | null }> {
    const membership = await this.connection.db!.collection('memberships')
      .findOne({ _id: membershipId }, { projection: { sessions_used: 1, service_sale_id: 1 } });
    const sale = membership
      ? await this.connection.db!.collection('service_sales').findOne({ _id: membership.service_sale_id }, { projection: { sessions_snapshot: 1 } })
      : null;
    return {
      used: membership?.sessions_used === undefined ? null : Number(membership.sessions_used),
      quota: sale?.sessions_snapshot === undefined ? null : Number(sale.sessions_snapshot),
    };
  }
}
