// Tầng nghiệp vụ (US-17 bước 1–2): Member xem gói, lần mua, giao dịch, chứng từ của CHÍNH mình; tính timeState và quota PT.
// Chủ thể luôn lấy từ account đang đăng nhập qua MemberOwnerReader (US-17-F01); chỉ đọc, không ghi gì (US-17-F05).
import { Injectable } from '@nestjs/common';
import { Types } from 'mongoose';
import { ApplicationError } from '../../common/errors/application-error';
import { ServerClock } from '../../common/utils/business-date';
import { MemberOwnerReader } from '../members/member-owner.reader';
import { toMeInvoice, toMeMembership, toMeServiceSale, toMeTransaction } from './me-memberships.mapper';
import { MeMembershipsRepository, SaleFilter } from './me-memberships.repository';
import {
  MeInvoiceDto, MeListPage, MeListQuery, MeMembershipDto, MeMembershipsQuery, MeServiceSaleDto, MeTransactionDto, TimeState,
} from './me-memberships.types';
import { Membership } from './schemas/membership.schema';
import { ServiceSale } from './schemas/service-sale.schema';

const OBJECT_ID = /^[0-9a-f]{24}$/i;

// Một kỳ gói cùng sale nguồn của nó (sale đã lọc theo member_id).
interface MembershipWithSale { membership: Membership; sale: ServiceSale }

// US-17-TC02: "của người khác" và "không tồn tại" trả CÙNG mã lỗi và thông điệp, để không lộ dữ liệu của ai đang có.
const notFound = (what: string) => new ApplicationError(404, 'NOT_FOUND', `Không tìm thấy ${what}`);

@Injectable()
export class MeMembershipsService {
  constructor(private readonly owners: MemberOwnerReader, private readonly repository: MeMembershipsRepository,
    private readonly clock: ServerClock) {}

  // US-17-TC01, US-17-TC03: danh sách kỳ gói của member; chưa link thì memberLinked=false, items rỗng.
  // Spec mục 2: lọc kind/storedStatus/timeState ngay trong DB, không tải hết rồi lọc.
  async listMemberships(accountId: string, query: MeMembershipsQuery): Promise<MeListPage<MeMembershipDto>> {
    const memberId = await this.owners.findMemberIdOfAccount(accountId);
    if (!memberId) return emptyPage(query);
    const filter = timeStateFilter(query.timeState, this.clock.today());
    // Loại gói (GYM/PT) lấy từ transaction của sale, chốt lúc bán (sale không có snapshot loại gói).
    if (query.kind) filter.transactionIds = await this.repository.findOwnTransactionIdsByKind(memberId, query.kind);
    const saleIds = await this.repository.findSaleIdsOfMember(memberId, filter);
    const skip = (query.page - 1) * query.limit;
    const memberships = await this.repository.findMembershipsPage(saleIds, query.storedStatus, skip, query.limit);
    const total = await this.repository.countMemberships(saleIds, query.storedStatus);
    // Đọc sale của các gói trên trang để lấy snapshot; vẫn lọc theo member_id.
    const sales = await this.repository.findSalesByIds(memberId, memberships.map(item => item.service_sale_id));
    const pairs: MembershipWithSale[] = [];
    for (const membership of memberships) {
      const sale = sales.find(item => item._id.equals(membership.service_sale_id));
      if (sale) pairs.push({ membership, sale });
    }
    return toPage(await this.toMembershipDtos(memberId, pairs), query, total);
  }

  // US-17-TC01, US-17-TC02: chi tiết kỳ gói; gói phải nối được tới sale của chính member.
  async getMembership(accountId: string, membershipId: string): Promise<MeMembershipDto> {
    const id = parseId(membershipId, 'gói tập');
    const memberId = await this.owners.findMemberIdOfAccount(accountId);
    // US-17-TC03: chưa link thì mọi chi tiết đều 404.
    if (!memberId) throw notFound('gói tập');
    const membership = await this.repository.findMembershipById(id);
    if (!membership) throw notFound('gói tập');
    const sale = await this.repository.findOwnSale(memberId, membership.service_sale_id);
    if (!sale) throw notFound('gói tập');
    const [dto] = await this.toMembershipDtos(memberId, [{ membership, sale }]);
    return dto;
  }

  // US-17 bước 2: tính kind, timeState, quota PT cho các gói (đã xác nhận là của member) rồi đổi sang DTO.
  // Chỉ 2 truy vấn cho cả trang: transaction (lấy kind) và đếm BOOKED, không truy vấn lặp từng gói.
  private async toMembershipDtos(memberId: Types.ObjectId, pairs: MembershipWithSale[]): Promise<MeMembershipDto[]> {
    const today = this.clock.today();
    const transactions = await this.repository.findOwnTransactionsByIds(memberId, pairs.map(pair => pair.sale.transaction_id));
    // US-17-F03: chỉ buổi BOOKED mới giữ chỗ (COMPLETED đã nằm trong sessions_used, CANCELLED trả lại buổi).
    const booked = await this.repository.countBookingsByStatus(pairs.map(pair => pair.membership._id), 'BOOKED');
    return pairs.map(({ membership, sale }) => {
      const transaction = transactions.find(item => item._id.equals(sale.transaction_id));
      const reserved = booked.get(membership._id.toHexString()) ?? 0;
      return toMeMembership(membership, sale, {
        kind: transaction?.kind,
        timeState: timeStateOf(sale.start_date, sale.end_date, today),
        sessionsReserved: reserved,
        sessionsAvailable: availableSessions(Number(sale.sessions_snapshot), Number(membership.sessions_used), reserved),
      });
    });
  }

  // US-17-TC01, US-17-TC03: danh sách lần mua của member.
  async listServiceSales(accountId: string, query: MeListQuery): Promise<MeListPage<MeServiceSaleDto>> {
    const memberId = await this.owners.findMemberIdOfAccount(accountId);
    if (!memberId) return emptyPage(query);
    const skip = (query.page - 1) * query.limit;
    const sales = await this.repository.findSalesPage(memberId, skip, query.limit);
    const total = await this.repository.countSales(memberId);
    const transactions = await this.repository.findOwnTransactionsByIds(memberId, sales.map(sale => sale.transaction_id));
    const memberships = await this.repository.findMembershipsBySaleIds(sales.map(sale => sale._id));
    const items = sales.map(sale => toMeServiceSale(
      sale,
      transactions.find(item => item._id.equals(sale.transaction_id)),
      memberships.find(item => item.service_sale_id.equals(sale._id)),
    ));
    return toPage(items, query, total);
  }

  // US-17-TC01, US-17-TC02: chi tiết lần mua; transaction của sale cũng phải cùng chủ.
  async getServiceSale(accountId: string, saleId: string): Promise<MeServiceSaleDto> {
    const id = parseId(saleId, 'lần mua gói');
    const memberId = await this.owners.findMemberIdOfAccount(accountId);
    if (!memberId) throw notFound('lần mua gói');
    const sale = await this.repository.findOwnSale(memberId, id);
    if (!sale) throw notFound('lần mua gói');
    const transaction = await this.repository.findOwnTransaction(memberId, sale.transaction_id);
    // Spec mục 2: chuỗi sale→transaction phải cùng chủ; lệch chủ thì coi như không tìm thấy.
    if (!transaction) throw notFound('lần mua gói');
    const [membership] = await this.repository.findMembershipsBySaleIds([sale._id]);
    return toMeServiceSale(sale, transaction, membership);
  }

  // US-17-TC01, US-17-TC02: chi tiết giao dịch của member, kèm khoản thu/chứng từ/kỳ gói nếu có.
  async getTransaction(accountId: string, transactionId: string): Promise<MeTransactionDto> {
    const id = parseId(transactionId, 'giao dịch');
    const memberId = await this.owners.findMemberIdOfAccount(accountId);
    if (!memberId) throw notFound('giao dịch');
    const transaction = await this.repository.findOwnTransaction(memberId, id);
    if (!transaction) throw notFound('giao dịch');
    // US-17-F04: chỉ khoản thu SUCCEEDED mới là "đã thu"; PENDING/FAILED không hiển thị như tiền đã trả.
    const payment = await this.repository.findPaymentByStatus(transaction._id, 'SUCCEEDED');
    const invoice = await this.repository.findInvoiceByTransaction(transaction._id);
    // Kỳ gói chỉ lấy qua sale cùng chủ với giao dịch.
    const sale = await this.repository.findOwnSaleByTransaction(memberId, transaction._id);
    const [membership] = sale ? await this.repository.findMembershipsBySaleIds([sale._id]) : [];
    return toMeTransaction(transaction, payment, invoice, membership ?? null);
  }

  // US-17-TC01, US-17-TC02: chứng từ chỉ xem được khi transaction gốc là của member.
  async getInvoice(accountId: string, invoiceId: string): Promise<MeInvoiceDto> {
    const id = parseId(invoiceId, 'chứng từ');
    const memberId = await this.owners.findMemberIdOfAccount(accountId);
    if (!memberId) throw notFound('chứng từ');
    const invoice = await this.repository.findInvoiceById(id);
    if (!invoice) throw notFound('chứng từ');
    const transaction = await this.repository.findOwnTransaction(memberId, invoice.transaction_id);
    if (!transaction) throw notFound('chứng từ');
    return toMeInvoice(invoice);
  }
}

// US-17-F02, US-17-TC05: đổi timeState thành điều kiện ngày theo hôm nay ở Việt Nam (ngày cuối vẫn còn dùng được).
//   CURRENT:   start_date <= hôm nay <= end_date
//   SCHEDULED: start_date > hôm nay
//   EXPIRED:   end_date < hôm nay
// Bộ lọc (timeStateFilter) và nhãn từng gói (timeStateOf) đặt cạnh nhau để luôn dùng CÙNG một luật.
function timeStateFilter(timeState: TimeState | undefined, today: string): SaleFilter {
  if (timeState === 'CURRENT') return { startDateOnOrBefore: today, endDateOnOrAfter: today };
  if (timeState === 'SCHEDULED') return { startDateAfter: today };
  if (timeState === 'EXPIRED') return { endDateBefore: today };
  return {};
}

// US-17-TC05: nhãn thời gian của một gói. Ngày dạng YYYY-MM-DD nên so sánh chuỗi đúng bằng so sánh ngày.
// Chỉ tính để hiển thị, không ghi lại memberships.status (storedStatus không đổi ngầm).
function timeStateOf(startDate: string, endDate: string, today: string): TimeState {
  if (startDate > today) return 'SCHEDULED';
  if (endDate < today) return 'EXPIRED';
  return 'CURRENT';
}

// US-17-F03, US-17-TC07: số buổi PT còn đặt được = quota − đã dùng − đang giữ chỗ, không nhỏ hơn 0.
// used đã gồm phần mang sang khi nâng cấp, nên chỉ dùng số của chính gói này, không cộng các gói cũ.
// Gói GYM có quota 0 nên luôn ra 0; giao diện dựa vào kind để hiện "không áp dụng" thay vì "hết buổi".
function availableSessions(quota: number, used: number, reserved: number): number {
  return Math.max(quota - used - reserved, 0);
}

// ID sai định dạng là dữ liệu sai → 400; đúng định dạng mà không có/của người khác → 404.
function parseId(value: string, what: string): Types.ObjectId {
  if (!OBJECT_ID.test(value)) throw new ApplicationError(400, 'INVALID_ID', `Mã ${what} không hợp lệ`);
  return new Types.ObjectId(value);
}

// Spec mục 2: {items,page,limit,total,totalPages}; danh sách rỗng thì totalPages = 0. asOf là thời điểm đọc (US-17-F05).
function toPage<T>(items: T[], query: MeListQuery, total: number): MeListPage<T> {
  return {
    memberLinked: true,
    items,
    page: query.page,
    limit: query.limit,
    total,
    totalPages: Math.ceil(total / query.limit),
    asOf: new Date().toISOString(),
  };
}

// US-17-TC03: chưa liên kết hồ sơ → trạng thái UX 200, không lộ hồ sơ nào, không tự nối theo phone.
function emptyPage<T>(query: MeListQuery): MeListPage<T> {
  return { ...toPage<T>([], query, 0), memberLinked: false };
}
