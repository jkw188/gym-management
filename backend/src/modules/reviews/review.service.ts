// Tầng nghiệp vụ (US-65 bước 2): Member gửi và xem lại đánh giá buổi PT của chính mình. Toàn bộ luật F01–F05 nằm ở file này.
// Gửi đánh giá chạy qua IdempotencyService (EN-02, operation PT_REVIEW_CREATE) và dùng CÙNG thứ tự khóa với Admin REOPEN US-64
// (S07-P01): khóa lịch → đọc lại booking → khóa member → kiểm chưa có đánh giá → ghi đánh giá + audit trong một transaction.
import { Injectable } from '@nestjs/common';
import { Types } from 'mongoose';
import { ApplicationError, invalidField } from '../../common/errors/application-error';
import { isDuplicateKey } from '../../common/http/http-error.filter';
import { ServerClock } from '../../common/utils/business-date';
import { DataGuardsService } from '../../infrastructure/transaction/data-guards.service';
import { BookingRepository } from '../bookings/booking.repository';
import { IdempotencyService, transactionRequestKey, WorkResult } from '../operations/idempotency.service';
import { REVIEW_COMMENT_MAX, TrainerReview } from './schemas/trainer-review.schema';
import { toReviewResponse } from './review.mapper';
import { ReviewRepository } from './review.repository';
import { OwnReviewResponse, ReviewResponse } from './review.types';

export interface CreateReviewInput {
  // Account id (chuỗi hex, lấy từ JWT) của Member; không nhận memberId từ client (US-65-TC02).
  actorId: string;
  bookingId: string;
  rating: number;
  comment?: string;
  idempotencyKey: string;
}

const OPERATION = 'PT_REVIEW_CREATE';
// US-65-F02: ký tự điều khiển bị từ chối, TRỪ tab (\t = 09), xuống dòng (\n = 0A) và \r (0D, phần của xuống dòng Windows).
const FORBIDDEN_CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

// US-65-TC02: booking không tồn tại và booking của người khác trả CÙNG một lỗi, không lộ booking có tồn tại hay không.
const notFound = () => new ApplicationError(404, 'NOT_FOUND', 'Không tìm thấy lịch tập');
// US-65-TC04, F05: chỉ buổi đang COMPLETED mới được đánh giá.
const notCompleted = () => new ApplicationError(409, 'BOOKING_NOT_COMPLETED', 'Chỉ đánh giá được buổi tập đã hoàn tất');
// US-65-F03, US-65-TC07: mỗi buổi chỉ một đánh giá.
const alreadyExists = () => new ApplicationError(409, 'REVIEW_ALREADY_EXISTS', 'Buổi tập này đã được đánh giá');

@Injectable()
export class ReviewService {
  constructor(
    private readonly reviews: ReviewRepository,
    // Đọc booking và ghi audit booking_events dùng chung repository của module lịch PT.
    private readonly bookings: BookingRepository,
    // EN-02: chống xử lý lặp theo Idempotency-Key; tự mở transaction và lưu operation_requests cùng commit.
    private readonly idempotency: IdempotencyService,
    // Khóa lịch và khóa member theo thứ tự cố định (US-28-G01, S07-P01).
    private readonly guards: DataGuardsService,
    private readonly clock: ServerClock,
  ) {}

  // POST /api/me/pt-bookings/:id/review
  async create(input: CreateReviewInput): Promise<ReviewResponse> {
    const actorId = this.toActorId(input.actorId);
    // US-65-TC05, TC06: kiểm và chuẩn hóa comment TRƯỚC khi mở transaction, không cần đọc DB.
    const comment = this.normalizeComment(input.comment);
    const bookingId = new Types.ObjectId(input.bookingId);
    const requestKey = transactionRequestKey(input.actorId, OPERATION, input.idempotencyKey);

    // US-65-TC09 (EN-02): payload chuẩn hóa gồm id booking, rating và comment ĐÃ trim.
    // Cùng key + cùng payload → trả lại 201/body gốc; khác payload → 409 IDEMPOTENCY_CONFLICT.
    const payload = { bookingId: bookingId.toHexString(), rating: input.rating, comment };

    const result = await this.idempotency.execute({ actorId: input.actorId, operation: OPERATION, clientKey: input.idempotencyKey, payload },
      async (session): Promise<WorkResult> => {
        // US-65-F04: giờ server ở MỖI lần driver chạy lại callback, không lấy giờ buổi tập hay giờ client.
        const now = this.clock.now();

        // US-65-F05: khóa lịch TRƯỚC khi đọc booking, cùng thứ tự với Admin REOPEN (US-64). Đánh giá và rút xác nhận
        // cùng lúc thì một bên phải chờ; bên sau đọc lại thấy kết quả của bên trước (không chỉ dựa vào GET trước submit).
        await this.guards.acquire(session, { schedule: true });

        // Đọc booking MỚI NHẤT trong session.
        const booking = await this.bookings.findBookingById(bookingId, session);
        if (!booking) throw notFound();

        // US-65-F01, US-65-TC02: account phải liên kết đúng member chủ booking (member_id bất biến, không theo
        // membership_id có thể đổi khi nâng cấp). Khác hoặc chưa liên kết → 404.
        const member = await this.reviews.findMemberOfAccount(actorId, session);
        if (!member || !member._id.equals(booking.member_id)) throw notFound();

        // US-65-TC04, F05: BOOKED/CANCELLED (kể cả vừa bị Admin REOPEN) → 409. Không xét gói còn hạn:
        // gói hết hạn sau buổi vẫn đánh giá được.
        if (booking.status !== 'COMPLETED') throw notCompleted();

        // US-65-F05, US-65-TC01: khóa member chủ booking (members.service_revision +1), sau khóa lịch.
        await this.guards.acquire(session, { members: [booking.member_id] });

        // US-65-F03, US-65-TC07: đã có đánh giá → 409, review gốc giữ nguyên.
        if (await this.reviews.findByBooking(bookingId, session)) throw alreadyExists();

        // US-65-F04, US-65-TC08: chụp owner và tên hiển thị lúc gửi; không copy điện thoại/email/địa chỉ.
        const trainerName = await this.reviews.findTrainerName(booking.trainer_id, session);
        let review: TrainerReview;
        try {
          review = await this.reviews.insert({
            bookingId,
            rating: input.rating,
            comment,
            createdAt: now,
            trainerId: booking.trainer_id,
            memberId: booking.member_id,
            createdBy: actorId,
            trainerName,
            memberName: member.full_name,
          }, session);
        } catch (error) {
          // US-65-TC09: unique booking_id là bảo vệ cuối cùng nếu hai lệnh lọt qua kiểm tra ở trên.
          if (isDuplicateKey(error)) throw alreadyExists();
          throw error;
        }

        // US-65-TC01 (spec mục 2 Audit/key): một dòng REVIEW_SUBMITTED cùng transaction; KHÔNG ghi comment vào audit.
        // Không trừ quota, không đổi booking, không thêm dòng COMPLETE (F04).
        await this.bookings.insertBookingEvent({
          bookingId,
          memberId: booking.member_id,
          membershipId: booking.membership_id,
          actorId,
          actorRole: 'MEMBER',
          action: 'REVIEW_SUBMITTED',
          occurredAt: now,
          beforeStatus: 'COMPLETED',
          afterStatus: 'COMPLETED',
          requestKey,
        }, session);

        const body = toReviewResponse(review);
        // { ...body }: chép sang object thường để TypeScript chấp nhận kiểu Record<string, unknown> của WorkResult.
        return { status: 201, body: { ...body }, resultIds: { reviewId: review._id, bookingId } };
      });
    // Body là kết quả vừa tạo hoặc kết quả gốc đã lưu khi gửi lại cùng key; cả hai đều do toReviewResponse tạo ra.
    return result.body as unknown as ReviewResponse;
  }

  // GET /api/me/pt-bookings/:id/review – chỉ đọc, không tạo đánh giá (US-65-TC02).
  async readOwn(actorIdText: string, bookingIdText: string): Promise<OwnReviewResponse> {
    const actorId = this.toActorId(actorIdText);
    const bookingId = new Types.ObjectId(bookingIdText);

    // US-65-TC02: booking không có hoặc của người khác → 404.
    const booking = await this.bookings.findBookingById(bookingId);
    if (!booking) throw notFound();
    const member = await this.reviews.findMemberOfAccount(actorId);
    if (!member || !member._id.equals(booking.member_id)) throw notFound();

    // US-65-TC07: đã gửi → trả bản gốc, không gửi thêm được.
    const review = await this.reviews.findByBooking(bookingId);
    if (review) return { review: toReviewResponse(review), canReview: false };

    // US-65-TC04: chưa gửi → canReview theo trạng thái buổi. Đây chỉ là gợi ý cho UI; POST vẫn kiểm lại.
    if (booking.status === 'COMPLETED') return { review: null, canReview: true };
    return { review: null, canReview: false, reason: 'BOOKING_NOT_COMPLETED' };
  }

  // Spec mục 2 (401 phiên không hợp lệ): actorId lấy từ JWT; sai định dạng nghĩa là không biết ai đang gọi.
  private toActorId(actorId: string): Types.ObjectId {
    if (!Types.ObjectId.isValid(actorId)) throw new ApplicationError(401, 'UNAUTHENTICATED', 'Cần đăng nhập lại');
    return new Types.ObjectId(actorId);
  }

  // US-65-F02, US-65-TC05, TC06: vắng/rỗng → ''; trim rồi kiểm ≤ 1000 ký tự; từ chối ký tự điều khiển (trừ xuống dòng/tab).
  // HTML giữ nguyên dạng chữ: React escape khi hiển thị, server không cắt hay kiểm duyệt từ khóa.
  private normalizeComment(comment: string | undefined): string {
    const trimmed = (comment ?? '').trim();
    if (trimmed.length > REVIEW_COMMENT_MAX) invalidField('comment', `Nhận xét tối đa ${REVIEW_COMMENT_MAX} ký tự`);
    if (FORBIDDEN_CONTROL_CHARS.test(trimmed)) invalidField('comment', 'Nhận xét chứa ký tự không hợp lệ');
    return trimmed;
  }
}
