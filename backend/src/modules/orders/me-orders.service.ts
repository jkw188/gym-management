// Tầng nghiệp vụ (US-42): Own Order Service – Member xem danh sách/chi tiết đơn của mình, hướng dẫn thanh toán, hóa đơn qua đơn (bước 1)
// và tự hủy đơn qua Cancel Order Service dùng chung của US-45 (bước 2). Các hàm đọc không đổi trạng thái, không giải phóng kho,
// không đánh dấu thông báo đã đọc (US-42-F03).
import { Injectable } from '@nestjs/common';
import { ClientSession, Filter } from 'mongodb';
import { Types } from 'mongoose';
import { ApplicationError } from '../../common/errors/application-error';
import { addCalendarDays, assertBusinessDate, ServerClock } from '../../common/utils/business-date';
import { validateObjectId } from '../../common/utils/normalization';
import { ReceivingAccountPolicy } from '../../common/utils/receiving-account';
import { fromVndDecimal } from '../../common/utils/vnd-money';
import { TransactionRunner } from '../../infrastructure/transaction/transaction-runner';
import { MemberOwnerReader } from '../members/member-owner.reader';
import { Transaction } from '../payments/schemas/transaction.schema';
import { CancelOrderService } from './cancel-order.service';
import { OwnOrderQueryDto } from './me-orders.dto';
import { CancelOrderDto } from './order-cancellation.dto';
import { RefundSummary, toOwnDetail, toOwnInvoice, toOwnListItem } from './me-orders.mapper';
import { Order } from './order.schema';
import { OrdersRepository } from './orders.repository';

const CASH_INSTRUCTION = 'Thanh toán tiền mặt tại quầy nhận hàng, đọc mã giao dịch cho nhân viên trước hạn giữ hàng. '
  + 'Đơn chỉ được tính là đã thu sau khi nhân viên xác nhận; đã thu chưa có nghĩa là đã nhận hàng.';
const notFound = () => new ApplicationError(404, 'NOT_FOUND', 'Không tìm thấy đơn hàng');

@Injectable()
export class MeOrdersService {
  constructor(private readonly repository: OrdersRepository, private readonly owners: MemberOwnerReader,
    private readonly accounts: ReceivingAccountPolicy, private readonly transactions: TransactionRunner, private readonly clock: ServerClock,
    private readonly cancellation: CancelOrderService) {}

  // POST /api/me/orders/:id/cancel – US-42-F04, bước 2: adapter mỏng, KHÔNG chép luật tồn/hoàn/trạng thái.
  // Toàn bộ luật nằm trong Cancel Order Service của US-45:
  //   - kiểm chủ đơn trước cả replay (TC02, TC11), rồi kiểm lại dưới khóa hội viên;
  //   - Idempotency-Key với operation ORDER_CANCEL_OWN: cùng key cùng payload trả body gốc, khác payload 409 (TC11);
  //   - COMPLETED 409, version cũ 409 VERSION_CONFLICT, giải phóng hàng giữ, hủy giao dịch PENDING hoặc ghi khoản hoàn PENDING khi đã thu (TC09, TC10).
  // own = true để US-45 chạy nhánh "Member tự hủy" thay cho nhánh Staff hỗ trợ.
  cancel(accountId: string, id: string, input: CancelOrderDto, key: string) {
    return this.cancellation.cancel(accountId, id, input, key, true);
  }

  // GET /api/me/orders – US-42-TC01, TC03, TC06.
  async list(accountId: string, query: OwnOrderQueryDto) {
    const filter = this.listFilter(query);
    // Spec mục 2: mọi truy vấn của một response (member, đơn, giao dịch, hoàn) nằm trong CÙNG một transaction snapshot.
    return this.transactions.run(async session => {
      const asOf = this.clock.now();
      // US-42-F01, TC03: member lấy từ principal; chưa liên kết → 200 rỗng có cờ, không tự liên kết theo phone.
      const memberId = await this.owners.findMemberIdOfAccount(accountId, session);
      if (!memberId) {
        return { memberLinked: false, items: [], page: query.page, limit: query.limit, total: 0, totalPages: 0, asOf: asOf.toISOString() };
      }
      // US-42-TC01: lọc member_id ở DB (không theo created_by) nên đơn POS do Staff tạo cho mình vẫn hiện.
      filter.member_id = memberId;
      const page = await this.repository.page(filter, undefined, query.page, query.limit, session);
      // Đọc giao dịch và khoản hoàn của cả trang bằng 2 truy vấn $in, không đọc từng đơn một.
      const transactions = await this.repository.transactionsByIds(page.items.map(order => order.transaction_id), session);
      const refunds = await this.repository.refundsByOrderIds(page.items.map(order => order._id), session);
      // Tên hàng của cả trang (snapshot lúc đặt) để danh sách hiện "Găng tay ×1, …" thay vì chỉ có mã đơn.
      const lines = await this.repository.linesByOrderIds(page.items.map(order => order._id), session);
      const transactionById = new Map(transactions.map(transaction => [String(transaction._id), transaction]));
      const items = page.items.map(order => toOwnListItem(order, transactionById.get(String(order.transaction_id)) ?? null,
        this.refundSummary(refunds.filter(refund => refund.order_id.equals(order._id))),
        lines.filter(line => line.order_id.equals(order._id))));
      return { memberLinked: true, ...page, items, asOf: asOf.toISOString() };
    });
  }

  // GET /api/me/orders/:id – US-42-TC02, TC05, TC06, TC07, TC08.
  async detail(accountId: string, id: string) {
    const orderId = new Types.ObjectId(validateObjectId(id));
    return this.transactions.run(async session => {
      const memberId = await this.ownerOrNotFound(accountId, session);
      const order = await this.ownOrderOrNotFound(memberId, orderId, session);
      const asOf = this.clock.now();
      const transaction = await this.repository.transaction(order.transaction_id, session);
      const items = await this.repository.lines(order._id, session);
      const invoice = await this.repository.invoice(order.transaction_id, session);
      const flags = {
        // US-42-TC08, S06-H01: đúng mốc hết hạn là đã hết hạn, kể cả khi worker chưa chạy.
        expired: asOf.getTime() >= order.reservation_expires_at.getTime(),
        cancelAllowed: this.cancelAllowed(order, transaction),
        paymentAllowed: this.paymentBlockedReason(order, transaction, asOf) === null,
      };
      return toOwnDetail(order, items, transaction, this.refundSummary(await this.repository.refunds(order._id, session)),
        invoice ? String(invoice._id) : null, flags, asOf);
    });
  }

  // GET /api/me/orders/:id/payment-instructions – US-42-F05, TC07.
  async paymentInstructions(accountId: string, id: string) {
    const orderId = new Types.ObjectId(validateObjectId(id));
    return this.transactions.run(async session => {
      const memberId = await this.ownerOrNotFound(accountId, session);
      const order = await this.ownOrderOrNotFound(memberId, orderId, session);
      const transaction = await this.repository.transaction(order.transaction_id, session);
      const blocked = this.paymentBlockedReason(order, transaction, this.clock.now());
      if (blocked === 'PAYMENT_NOT_ALLOWED') throw new ApplicationError(409, blocked, 'Đơn này không còn cần thanh toán');
      if (blocked === 'RESERVATION_EXPIRED') throw new ApplicationError(409, blocked, 'Đã hết hạn giữ hàng; nếu đã chuyển tiền hãy liên hệ quầy để đối chiếu');
      // Đến đây paymentBlockedReason đã bảo đảm có transaction PENDING.
      const pending = transaction!;
      // US-42-TC07: chỉ dùng tài khoản nhận đã cấu hình thật; thiếu cấu hình thì không có transferOptions, vẫn hướng dẫn tiền mặt.
      // Nội dung chuyển khoản là mã giao dịch của server.
      const transferOptions = order.preferred_payment_method === 'TRANSFER'
        ? this.accounts.transferAccounts().map(account => ({ receivingAccountCode: account.code, bankName: account.bankName,
          accountNumber: account.accountNumber, accountName: account.accountName, transferContent: pending.code }))
        : [];
      return {
        transactionCode: pending.code, amountDue: fromVndDecimal(pending.amount_due), preferredPaymentMethod: order.preferred_payment_method,
        pickupLocation: order.pickup_location_snapshot, cashInstructions: CASH_INSTRUCTION,
        ...(transferOptions.length > 0 ? { transferOptions } : {}),
      };
    });
  }

  // GET /api/me/orders/:id/invoice – US-42-TC06: hóa đơn chỉ mở qua đơn của chính mình; chưa có hóa đơn → 404.
  async invoice(accountId: string, id: string) {
    const orderId = new Types.ObjectId(validateObjectId(id));
    return this.transactions.run(async session => {
      const memberId = await this.ownerOrNotFound(accountId, session);
      const order = await this.ownOrderOrNotFound(memberId, orderId, session);
      const invoice = await this.repository.invoice(order.transaction_id, session);
      if (!invoice) throw new ApplicationError(404, 'NOT_FOUND', 'Đơn chưa có hóa đơn');
      const items = await this.repository.lines(order._id, session);
      const payment = await this.repository.succeededPayment(order.transaction_id, session);
      return toOwnInvoice(invoice, items, payment);
    });
  }

  // US-42-TC06: điều kiện lọc của danh sách (chưa có member_id).
  private listFilter(query: OwnOrderQueryDto): Filter<Order> {
    // Ngày theo giờ Việt Nam, bao gồm hai đầu; mặc định 30 ngày gần nhất (hôm nay và 29 ngày trước).
    const to = assertBusinessDate(query.toDate ?? this.clock.today());
    const from = assertBusinessDate(query.fromDate ?? addCalendarDays(to, -29));
    const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000 + 1;
    if (days < 1 || days > 366) throw new ApplicationError(400, 'VALIDATION_ERROR', 'Khoảng ngày phải từ 1 đến 366 ngày');
    const filter: Filter<Order> = {
      created_at: { $gte: new Date(`${from}T00:00:00+07:00`), $lt: new Date(`${addCalendarDays(to, 1)}T00:00:00+07:00`) },
    };
    if (query.status) filter.status = query.status;
    if (query.channel) filter.channel = query.channel;
    // q khớp một phần mã đơn, không phân biệt hoa thường; escape ký tự đặc biệt để . * ( là chữ thường, không chạy như regex.
    if (query.q) filter.code = new RegExp(query.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    return filter;
  }

  // US-42-TC03: account chưa liên kết hồ sơ thì mọi route theo id đều 404.
  private async ownerOrNotFound(accountId: string, session: ClientSession) {
    const memberId = await this.owners.findMemberIdOfAccount(accountId, session);
    if (!memberId) throw notFound();
    return memberId;
  }

  // US-42-TC02: đơn của Member khác, POS ẩn danh hoặc id không tồn tại đều 404 giống nhau, không lộ dữ liệu.
  private async ownOrderOrNotFound(memberId: Types.ObjectId, orderId: Types.ObjectId, session: ClientSession) {
    const order = await this.repository.ownOrder(memberId, orderId, session);
    if (!order) throw notFound();
    return order;
  }

  // US-42-F04: gợi ý hủy được khi chưa bàn giao (PENDING/CONFIRMED, còn giữ hàng), kể cả đã thu hoặc đã đến hạn.
  // Lệnh hủy thật (US-45) vẫn kiểm lại; COMPLETED không hủy.
  private cancelAllowed(order: Order, transaction: Transaction | null) {
    return (order.status === 'PENDING' || order.status === 'CONFIRMED') && order.reservation_state === 'HELD'
      && (transaction?.status === 'PENDING' || transaction?.status === 'SETTLED');
  }

  // US-42-F05, TC07: kiểm theo thứ tự spec 1.0.1 – đơn đã kết thúc, giao dịch không còn PENDING hoặc 0 đồng → PAYMENT_NOT_ALLOWED;
  // còn lại mà đã đến hạn giữ hàng → RESERVATION_EXPIRED. null = được hướng dẫn thanh toán.
  private paymentBlockedReason(order: Order, transaction: Transaction | null, now: Date) {
    if (order.status === 'CANCELLED' || order.status === 'COMPLETED') return 'PAYMENT_NOT_ALLOWED';
    if (!transaction || transaction.status !== 'PENDING' || fromVndDecimal(transaction.amount_due) === '0') return 'PAYMENT_NOT_ALLOWED';
    if (order.reservation_state !== 'HELD') return 'PAYMENT_NOT_ALLOWED';
    if (now.getTime() >= order.reservation_expires_at.getTime()) return 'RESERVATION_EXPIRED';
    return null;
  }

  // US-42-F02, TC05: trạng thái hoàn lấy từ collection refunds thật, cùng quy tắc với kết quả hủy US-45:
  // còn khoản PENDING → PENDING; không có PENDING mà có FAILED → FAILED; tất cả SUCCEEDED → SUCCEEDED; không có → NONE, số tiền "0".
  private refundSummary(refunds: { amount: Types.Decimal128; status: string }[]): RefundSummary {
    let amount = 0n;
    for (const refund of refunds) amount += BigInt(fromVndDecimal(refund.amount));
    let refundState: RefundSummary['refundState'] = 'NONE';
    if (refunds.some(refund => refund.status === 'PENDING')) refundState = 'PENDING';
    else if (refunds.some(refund => refund.status === 'FAILED')) refundState = 'FAILED';
    else if (refunds.length > 0) refundState = 'SUCCEEDED';
    return { refundState, refundAmount: String(amount) };
  }
}
