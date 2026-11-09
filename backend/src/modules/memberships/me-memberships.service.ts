// Tầng nghiệp vụ (US-17 bước 1): Member xem gói, lần mua, giao dịch, chứng từ của CHÍNH mình.
// Chủ thể luôn lấy từ account đang đăng nhập qua MemberOwnerReader (US-17-F01); chỉ đọc, không ghi gì (US-17-F05).
import { Injectable } from '@nestjs/common';
import { Types } from 'mongoose';
import { ApplicationError } from '../../common/errors/application-error';
import { MemberOwnerReader } from '../members/member-owner.reader';
import { toMeInvoice, toMeMembership, toMeServiceSale, toMeTransaction } from './me-memberships.mapper';
import { MeMembershipsRepository } from './me-memberships.repository';
import {
  MeInvoiceDto, MeListPage, MeListQuery, MeMembershipDto, MeServiceSaleDto, MeTransactionDto,
} from './me-memberships.types';

const OBJECT_ID = /^[0-9a-f]{24}$/i;

// US-17-TC02: "của người khác" và "không tồn tại" trả CÙNG mã lỗi và thông điệp, để không lộ dữ liệu của ai đang có.
const notFound = (what: string) => new ApplicationError(404, 'NOT_FOUND', `Không tìm thấy ${what}`);

@Injectable()
export class MeMembershipsService {
  constructor(private readonly owners: MemberOwnerReader, private readonly repository: MeMembershipsRepository) {}

  // US-17-TC01, US-17-TC03: danh sách kỳ gói của member; chưa link thì memberLinked=false, items rỗng.
  async listMemberships(accountId: string, query: MeListQuery): Promise<MeListPage<MeMembershipDto>> {
    const memberId = await this.owners.findMemberIdOfAccount(accountId);
    if (!memberId) return emptyPage(query);
    const saleIds = await this.repository.findSaleIdsOfMember(memberId);
    const skip = (query.page - 1) * query.limit;
    const memberships = await this.repository.findMembershipsPage(saleIds, skip, query.limit);
    const total = await this.repository.countMemberships(saleIds);
    // Đọc sale của các gói trên trang để lấy snapshot; vẫn lọc theo member_id.
    const sales = await this.repository.findSalesByIds(memberId, memberships.map(item => item.service_sale_id));
    const items: MeMembershipDto[] = [];
    for (const membership of memberships) {
      const sale = sales.find(item => item._id.equals(membership.service_sale_id));
      if (sale) items.push(toMeMembership(membership, sale));
    }
    return toPage(items, query, total);
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
    return toMeMembership(membership, sale);
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
    const payment = await this.repository.findSucceededPayment(transaction._id);
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
