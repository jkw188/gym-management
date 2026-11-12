// Tầng nghiệp vụ (US-64 bước 2): PT xác nhận buổi đã dạy BOOKED → COMPLETED và trừ đúng một buổi của gói.
// Trong CÙNG transaction: khóa lịch → đọc booking → khóa member → đọc gói, quota → CAS booking → sessions_used +1 → audit.
// Chạy qua IdempotencyService (EN-02): gửi lại cùng Idempotency-Key trả kết quả gốc, operation_requests cùng commit.
// US-64 bước 3: tách phần ghi trong transaction thành completeInSession để Admin xác nhận hỗ trợ (C01) dùng CÙNG điều kiện.
// US-64 bước 4: lưu thông báo PT_BOOKING_COMPLETED:<id>:<revision> cho Member và PT cùng transaction (F05, EN-03).
import { Injectable } from '@nestjs/common';
import { ClientSession } from 'mongodb';
import { Types } from 'mongoose';
import { ApplicationError } from '../../common/errors/application-error';
import { ServerClock } from '../../common/utils/business-date';
import { DataGuardsService } from '../../infrastructure/transaction/data-guards.service';
import { NotificationsService } from '../notifications/notifications.service';
import { IdempotencyService, transactionRequestKey, WorkResult } from '../operations/idempotency.service';
import { toBookingCompletedMessage, toCompletedPtBooking } from './booking.mapper';
import { BookingRepository } from './booking.repository';
import { CompletedPtBooking } from './booking.types';
import { CompletedActorType, PtBooking } from './schemas/pt-booking.schema';

export interface CompleteBookingInput {
  // Account id (chuỗi hex, lấy từ JWT) của PT bấm xác nhận.
  actorId: string;
  bookingId: string;
  // Version client đang thấy; khác version trong DB → 409 VERSION_CONFLICT.
  version: number;
  // Idempotency-Key (UUID v4): chống xử lý lặp (EN-02) và băm request_key của audit.
  idempotencyKey: string;
}

// Người xác nhận, dùng chung cho PT (TRAINER) và Admin hỗ trợ (ADMIN_SUPPORT, có lý do).
export interface CompletionActor {
  accountId: Types.ObjectId;
  type: CompletedActorType;
  // US-64-C01: Admin bắt buộc có lý do (đã trim); PT không có.
  reason?: string;
  // request_key của dòng audit (băm actor|operation|key theo EN-02).
  requestKey: string;
}

const OPERATION = 'PT_BOOKING_COMPLETE';

const conflict = (code: string, message: string) => new ApplicationError(409, code, message);
// US-64-TC02: booking không tồn tại và booking của PT khác trả CÙNG một lỗi, không lộ booking có tồn tại hay không.
export const bookingNotFound = () => new ApplicationError(404, 'NOT_FOUND', 'Không tìm thấy lịch tập');
// US-64-TC05: dữ liệu gói/quota sai thì dừng, không tự chữa; người vận hành đối chiếu và sửa.
export const dataIntegrityError = () => new ApplicationError(409, 'DATA_INTEGRITY_ERROR', 'Dữ liệu gói tập không nhất quán. Vui lòng liên hệ quản trị');
export const versionConflict = () => conflict('VERSION_CONFLICT', 'Lịch tập đã thay đổi. Vui lòng tải lại');

@Injectable()
export class CompleteBookingService {
  constructor(
    private readonly repository: BookingRepository,
    private readonly idempotency: IdempotencyService,
    // Khóa lịch và khóa member theo thứ tự cố định schedule_guards → members (US-64-F04).
    private readonly guards: DataGuardsService,
    // EN-03: lưu thông báo + người nhận + outbox cùng transaction.
    private readonly notifications: NotificationsService,
    private readonly clock: ServerClock,
  ) {}

  // POST /api/me/pt-bookings/:id/complete: PT xác nhận buổi mình đã dạy.
  async complete(input: CompleteBookingInput): Promise<CompletedPtBooking> {
    // actorId lấy từ JWT; sai định dạng nghĩa là không biết ai đang gọi → 401 (giống lệnh hủy US-29).
    if (!Types.ObjectId.isValid(input.actorId)) throw new ApplicationError(401, 'UNAUTHENTICATED', 'Cần đăng nhập lại');
    const bookingId = new Types.ObjectId(input.bookingId);
    const actor: CompletionActor = {
      accountId: new Types.ObjectId(input.actorId),
      type: 'TRAINER',
      requestKey: transactionRequestKey(input.actorId, OPERATION, input.idempotencyKey),
    };

    // US-64-TC06 (EN-02): payload chuẩn hóa gồm id booking và version. Cùng key + cùng payload → trả lại 200/body gốc,
    // không trừ buổi lần hai; khác payload → 409 IDEMPOTENCY_CONFLICT.
    const payload = { bookingId: bookingId.toHexString(), version: input.version };

    const result = await this.idempotency.execute({ actorId: input.actorId, operation: OPERATION, clientKey: input.idempotencyKey, payload },
      async (session): Promise<WorkResult> => {
        const body = await this.completeInSession(session, bookingId, input.version, actor);
        // { ...body }: chép sang object thường để TypeScript chấp nhận kiểu Record<string, unknown> của WorkResult.
        return { status: 200, body: { ...body }, resultIds: { bookingId } };
      });
    // Body là kết quả vừa tạo hoặc kết quả gốc đã lưu khi gửi lại cùng key; cả hai đều do toCompletedPtBooking tạo ra.
    return result.body as unknown as CompletedPtBooking;
  }

  // Toàn bộ luật hoàn tất, chạy trong session của transaction người gọi đã mở (PT: complete; Admin: CorrectBookingService).
  // US-64-C01: Admin xác nhận hỗ trợ dùng CÙNG điều kiện trạng thái, giờ, gói/quota và thứ tự khóa với PT.
  async completeInSession(session: ClientSession, bookingId: Types.ObjectId, version: number, actor: CompletionActor): Promise<CompletedPtBooking> {
    // US-64-F01: giờ server lấy ở MỖI lần driver chạy lại callback, không tin giờ client.
    const now = this.clock.now();

    // US-64-F04, US-64-TC07: khóa lịch TRƯỚC khi đọc booking, cùng thứ tự với lệnh đặt (US-28) và hủy (US-29):
    // xác nhận và hủy hỗ trợ cùng lúc phải xếp hàng, nên chỉ một bên chuyển được trạng thái.
    await this.guards.acquire(session, { schedule: true });

    const booking = await this.repository.findBookingById(bookingId, session);
    if (!booking) throw bookingNotFound();
    // US-64-F01, US-64-TC02: PT chỉ xác nhận buổi của chính mình; PT khác → 404. Admin hỗ trợ không cần là PT của buổi.
    if (actor.type === 'TRAINER') {
      const trainerId = await this.repository.findTrainerIdOfAccount(actor.accountId, session);
      if (!trainerId || !trainerId.equals(booking.trainer_id)) throw bookingNotFound();
    }

    // Kiểm trạng thái trước version: buổi đã hoàn tất thì báo rõ BOOKING_ALREADY_COMPLETED dù version đúng.
    // US-64-F05, US-64-TC06, US-64-TC10: key mới trên buổi COMPLETED → 409, không trừ buổi lần hai.
    if (booking.status === 'COMPLETED') throw conflict('BOOKING_ALREADY_COMPLETED', 'Buổi tập đã được xác nhận hoàn tất');
    // US-64-F05, US-64-TC03: buổi CANCELLED không hoàn tất được.
    if (booking.status !== 'BOOKED') throw conflict('INVALID_BOOKING_STATE', 'Lịch tập không còn ở trạng thái có thể xác nhận');

    // US-64-F04, US-64-TC03: client giữ version cũ → 409 để tải lại.
    if (booking.version !== version) throw versionConflict();

    // US-64-F01, US-64-TC01, US-64-TC03, US-64-TC10: chỉ xác nhận khi giờ server ≥ giờ kết thúc buổi (đúng bằng endAt vẫn được).
    if (now.getTime() < booking.end_at.getTime()) throw conflict('BOOKING_NOT_ENDED', 'Buổi tập chưa kết thúc, chưa thể xác nhận');

    // US-64-F04: khóa member chủ booking (members.service_revision +1) SAU khóa lịch, TRƯỚC khi đọc gói/quota.
    // Nâng cấp gói (US-16/20) cũng lấy khóa này nên hai lệnh xếp hàng, không cùng đọc một số liệu cũ.
    await this.guards.acquire(session, { members: [booking.member_id] });

    // US-64-F04, US-64-TC08: gói bị trừ là membership_id booking đang tham chiếu đọc TRONG transaction này
    // (nâng cấp đã commit trước thì là gói đích), không lấy từ client hay từ lần GET trước.
    // Nếu nâng cấp ghi xen vào sau khi transaction này bắt đầu đọc, bước khóa member hoặc CAS bên dưới bị
    // write conflict, driver chạy lại cả callback và đọc được booking mới.
    const usedBefore = await this.checkMembership(booking, session);

    // US-64-F02, US-64-TC01, US-64-TC10: BOOKED → COMPLETED, version+1, completion_revision+1; ghi người, loại người và gói bị trừ.
    // completed_at là giờ xác nhận (không giả là endAt).
    const completed = await this.repository.completeBooking({
      bookingId, version: booking.version, completedBy: actor.accountId, completedActorType: actor.type,
      membershipId: booking.membership_id, now,
    }, session);
    // CAS không khớp: booking vừa bị đổi giữa lúc đọc và lúc ghi.
    if (!completed) throw versionConflict();

    // US-64-F02: sessions_used +1 cùng transaction. Số BOOKED tự giảm 1 vì booking vừa thành COMPLETED,
    // nên used + BOOKED (và số buổi còn có thể đặt) không đổi.
    const usedAfter = await this.repository.addSessionsUsed(booking.membership_id, 1, session);
    if (usedAfter === null) throw dataIntegrityError();

    // US-64-C04, US-64-TC01, US-64-TC10: một dòng audit COMPLETE cùng transaction với revision, used và version trước–sau.
    // Admin hỗ trợ ghi actor_role ADMIN kèm lý do, không mạo danh PT.
    await this.repository.insertBookingEvent({
      bookingId,
      memberId: booking.member_id,
      membershipId: booking.membership_id,
      actorId: actor.accountId,
      actorRole: actor.type === 'TRAINER' ? 'TRAINER' : 'ADMIN',
      action: 'COMPLETE',
      reason: actor.reason,
      occurredAt: now,
      beforeStatus: 'BOOKED',
      afterStatus: 'COMPLETED',
      requestKey: actor.requestKey,
      completionRevision: completed.completion_revision,
      usedBefore,
      usedAfter,
      versionBefore: booking.version,
      versionAfter: completed.version,
    }, session);

    // US-64-F05, US-64-TC09: thông báo PT_BOOKING_COMPLETED:<bookingId>:<revision> trong CÙNG session (notification + recipients + outbox).
    // Mỗi lượt hoàn tất hợp lệ có revision riêng nên xác nhận lại sau REOPEN có thông báo mới (C04); gửi lại cùng key thì
    // IdempotencyService trả body gốc, không chạy tới đây. Lỗi insert → rollback cả hoàn tất. Socket do outbox worker phát sau commit.
    const message = toBookingCompletedMessage(completed);
    const event = await this.notifications.persistBusinessEvent(session, {
      eventKey: `PT_BOOKING_COMPLETED:${bookingId.toHexString()}:${completed.completion_revision}`,
      title: message.title,
      body: message.body,
      memberId: booking.member_id.toHexString(),
      createdBy: actor.accountId.toHexString(),
    }, await this.findRecipients(completed, session));

    return toCompletedPtBooking(completed, usedAfter, event.notificationState);
  }

  // US-64-F05: người nhận chụp lúc commit = account đang liên kết của Member + account của PT (dạng chuỗi hex cho EN-03).
  private async findRecipients(booking: PtBooking, session: ClientSession): Promise<string[]> {
    const memberAccount = await this.repository.findAccountIdOfMember(booking.member_id, session);
    const trainerAccount = await this.repository.findAccountIdOfTrainer(booking.trainer_id, session);
    const recipients: string[] = [];
    if (memberAccount) recipients.push(memberAccount.toHexString());
    if (trainerAccount) recipients.push(trainerAccount.toHexString());
    return recipients;
  }

  // US-64-F02, US-64-TC05: gói booking đang tham chiếu phải tồn tại, của đúng Member, loại PT, giao dịch SETTLED,
  // có sessions_used và used + số BOOKED ≤ quota. Sai → 409 DATA_INTEGRITY_ERROR, không tự chữa.
  // US-64-TC04: KHÔNG kiểm gói còn hạn hay còn ACTIVE, vì buổi có thể được xác nhận muộn sau hạn gói.
  // US-64-C02: Admin rút xác nhận cũng gọi hàm này để kiểm "dữ liệu nguồn nhất quán".
  // Trả sessions_used hiện tại (trước khi đổi).
  async checkMembership(booking: PtBooking, session: ClientSession): Promise<number> {
    const membership = await this.repository.findMembership(booking.membership_id, session);
    if (!membership) throw dataIntegrityError();
    const sale = await this.repository.findOwnSale(booking.member_id, membership.service_sale_id, session);
    if (!sale) throw dataIntegrityError();
    const transaction = await this.repository.findOwnTransaction(booking.member_id, sale.transaction_id, session);
    if (transaction?.kind !== 'PT' || transaction.status !== 'SETTLED') throw dataIntegrityError();

    // sessions_used phải là số nguyên ≥ 0 (thiếu field thì Number(undefined) = NaN, không phải số nguyên).
    const used = Number(membership.sessions_used);
    if (!Number.isInteger(used) || used < 0) throw dataIntegrityError();

    // Số BOOKED đã gồm chính buổi đang xác nhận.
    const quota = Number(sale.sessions_snapshot);
    const booked = await this.repository.countBookingsOfMembership(booking.membership_id, 'BOOKED', session);
    if (used + booked > quota) throw dataIntegrityError();
    return used;
  }
}
