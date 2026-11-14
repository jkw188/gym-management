// Tầng dữ liệu (US-27 bước 2): nơi duy nhất đọc lịch PT riêng của một Member trong pt_bookings.
// Mọi truy vấn đều có điều kiện member_id: chủ buổi theo member_id, không suy từ membership hiện tại (US-27-TC08).
// US-65 bước 3: đọc thêm trainer_reviews để biết buổi nào đã được đánh giá (projection reviewState).
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { TrainerReview } from '../reviews/schemas/trainer-review.schema';
import { PtBooking, PtBookingStatus } from './schemas/pt-booking.schema';

// Bộ lọc đã kiểm tra ở service: chủ buổi, các trạng thái cần lấy và khoảng UTC [from, to).
export interface OwnBookingFilter {
  memberId: Types.ObjectId;
  statuses: PtBookingStatus[];
  from: Date;
  to: Date;
}

// Buổi thuộc ngày có giờ bắt đầu nằm trong [from, to). Dùng index member_id,status,start_at,end_at.
function ownBookingCondition(filter: OwnBookingFilter) {
  return {
    member_id: filter.memberId,
    status: { $in: filter.statuses },
    start_at: { $gte: filter.from, $lt: filter.to },
  };
}

@Injectable()
export class MePtBookingsRepository {
  constructor(
    @InjectModel('PtBooking') private readonly bookings: Model<PtBooking>,
    @InjectModel('TrainerReview') private readonly reviews: Model<TrainerReview>,
  ) {}

  // Một trang lịch riêng, sắp startAt ASC rồi _id ASC để phân trang không rơi hay trùng buổi cùng giờ.
  findOwnPage(filter: OwnBookingFilter, skip: number, limit: number): Promise<PtBooking[]> {
    return this.bookings.find(ownBookingCondition(filter)).sort({ start_at: 1, _id: 1 }).skip(skip).limit(limit)
      .maxTimeMS(5000).lean<PtBooking[]>().exec();
  }

  countOwn(filter: OwnBookingFilter): Promise<number> {
    return this.bookings.countDocuments(ownBookingCondition(filter)).maxTimeMS(5000).exec();
  }

  // US-27-TC07: chỉ tìm trong buổi của chính member; buổi của người khác coi như không tồn tại.
  findOwnById(memberId: Types.ObjectId, id: Types.ObjectId): Promise<PtBooking | null> {
    return this.bookings.findOne({ _id: id, member_id: memberId }).maxTimeMS(5000).lean<PtBooking>().exec();
  }

  // US-65-TC07: review đã gửi của các buổi đang hiển thị, chỉ lấy _id và booking_id. Dùng index unique booking_id.
  // bookingIds là các buổi đã lọc theo member_id của chính Member, nên không đọc được review của người khác (US-65-TC02).
  // Lọc theo booking_id giống hệt cách POST kiểm "đã có đánh giá" (bước 2), để gợi ý và kiểm thật không lệch nhau.
  findReviewsOfBookings(bookingIds: Types.ObjectId[]): Promise<Pick<TrainerReview, '_id' | 'booking_id'>[]> {
    if (bookingIds.length === 0) return Promise.resolve([]);
    return this.reviews.find({ booking_id: { $in: bookingIds } }, { _id: 1, booking_id: 1 })
      .maxTimeMS(5000).lean<Pick<TrainerReview, '_id' | 'booking_id'>[]>().exec();
  }
}
