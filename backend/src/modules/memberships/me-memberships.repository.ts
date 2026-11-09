// Tầng dữ liệu (US-17 bước 1): nơi duy nhất ĐỌC service_sales, memberships, transactions, payments, invoices cho API cá nhân.
// Spec US-17 mục 2: mọi truy vấn lọc chủ sở hữu (member_id) ngay trong DB, không tải hết rồi lọc ở nơi khác. Không có hàm ghi.
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { QueryFilter, Model, Types } from 'mongoose';
import { Invoice } from '../payments/schemas/invoice.schema';
import { Payment, PaymentStatus } from '../payments/schemas/payment.schema';
import { Transaction, TransactionKind } from '../payments/schemas/transaction.schema';
import { Membership, MembershipStatus } from './schemas/membership.schema';
import { ServiceSale } from './schemas/service-sale.schema';

// Điều kiện lọc sale, không chứa luật nghiệp vụ: service quyết định giá trị (ví dụ đổi timeState thành ngày).
export interface SaleFilter {
  transactionIds?: Types.ObjectId[];
  startDateAfter?: string;        // start_date > giá trị
  startDateOnOrBefore?: string;   // start_date <= giá trị
  endDateBefore?: string;         // end_date < giá trị
  endDateOnOrAfter?: string;      // end_date >= giá trị
}

function membershipCondition(saleIds: Types.ObjectId[], status: MembershipStatus | undefined): QueryFilter<Membership> {
  return status ? { service_sale_id: { $in: saleIds }, status } : { service_sale_id: { $in: saleIds } };
}

@Injectable()
export class MeMembershipsRepository {
  constructor(
    @InjectModel('ServiceSale') private readonly sales: Model<ServiceSale>,
    @InjectModel('Membership') private readonly memberships: Model<Membership>,
    @InjectModel('Transaction') private readonly transactions: Model<Transaction>,
    @InjectModel('Payment') private readonly payments: Model<Payment>,
    @InjectModel('Invoice') private readonly invoices: Model<Invoice>,
  ) {}

  // ----- service_sales: luôn có điều kiện member_id -----

  // Mã các sale của member; dùng để lọc memberships (membership không có member_id, chủ sở hữu đi qua sale).
  // filter do service tạo; repository chỉ đổi thành điều kiện MongoDB, lọc ngay trong DB.
  async findSaleIdsOfMember(memberId: Types.ObjectId, filter: SaleFilter = {}): Promise<Types.ObjectId[]> {
    const condition: QueryFilter<ServiceSale> = { member_id: memberId };
    if (filter.transactionIds) condition.transaction_id = { $in: filter.transactionIds };
    // start_date, end_date là chuỗi YYYY-MM-DD nên so sánh chuỗi đúng bằng so sánh ngày.
    const startDate: Record<string, string> = {};
    if (filter.startDateAfter) startDate.$gt = filter.startDateAfter;
    if (filter.startDateOnOrBefore) startDate.$lte = filter.startDateOnOrBefore;
    if (Object.keys(startDate).length > 0) condition.start_date = startDate;
    const endDate: Record<string, string> = {};
    if (filter.endDateBefore) endDate.$lt = filter.endDateBefore;
    if (filter.endDateOnOrAfter) endDate.$gte = filter.endDateOnOrAfter;
    if (Object.keys(endDate).length > 0) condition.end_date = endDate;
    const sales = await this.sales.find(condition, { _id: 1 }).maxTimeMS(5000).lean<{ _id: Types.ObjectId }[]>().exec();
    return sales.map(sale => sale._id);
  }

  // Một trang sale của member, mới nhất trước (_id giảm dần).
  findSalesPage(memberId: Types.ObjectId, skip: number, limit: number): Promise<ServiceSale[]> {
    return this.sales.find({ member_id: memberId }).sort({ _id: -1 }).skip(skip).limit(limit)
      .maxTimeMS(5000).lean<ServiceSale[]>().exec();
  }

  countSales(memberId: Types.ObjectId): Promise<number> {
    return this.sales.countDocuments({ member_id: memberId }).maxTimeMS(5000).exec();
  }

  findSalesByIds(memberId: Types.ObjectId, ids: Types.ObjectId[]): Promise<ServiceSale[]> {
    return this.sales.find({ _id: { $in: ids }, member_id: memberId }).maxTimeMS(5000).lean<ServiceSale[]>().exec();
  }

  findOwnSale(memberId: Types.ObjectId, saleId: Types.ObjectId): Promise<ServiceSale | null> {
    return this.sales.findOne({ _id: saleId, member_id: memberId }).maxTimeMS(5000).lean<ServiceSale>().exec();
  }

  findOwnSaleByTransaction(memberId: Types.ObjectId, transactionId: Types.ObjectId): Promise<ServiceSale | null> {
    return this.sales.findOne({ transaction_id: transactionId, member_id: memberId }).maxTimeMS(5000).lean<ServiceSale>().exec();
  }

  // ----- memberships: chỉ tìm trong danh sách sale đã lọc theo member -----

  // status không truyền thì lấy mọi trạng thái.
  findMembershipsPage(saleIds: Types.ObjectId[], status: MembershipStatus | undefined, skip: number, limit: number): Promise<Membership[]> {
    return this.memberships.find(membershipCondition(saleIds, status)).sort({ _id: -1 }).skip(skip).limit(limit)
      .maxTimeMS(5000).lean<Membership[]>().exec();
  }

  countMemberships(saleIds: Types.ObjectId[], status: MembershipStatus | undefined): Promise<number> {
    return this.memberships.countDocuments(membershipCondition(saleIds, status)).maxTimeMS(5000).exec();
  }

  findMembershipById(id: Types.ObjectId): Promise<Membership | null> {
    return this.memberships.findById(id).maxTimeMS(5000).lean<Membership>().exec();
  }

  findMembershipsBySaleIds(saleIds: Types.ObjectId[]): Promise<Membership[]> {
    return this.memberships.find({ service_sale_id: { $in: saleIds } }).maxTimeMS(5000).lean<Membership[]>().exec();
  }

  // ----- transactions: luôn có điều kiện member_id -----

  findOwnTransaction(memberId: Types.ObjectId, id: Types.ObjectId): Promise<Transaction | null> {
    return this.transactions.findOne({ _id: id, member_id: memberId }).maxTimeMS(5000).lean<Transaction>().exec();
  }

  // Mã các giao dịch của member theo loại (GYM/PT); dùng để lọc sale theo kind.
  async findOwnTransactionIdsByKind(memberId: Types.ObjectId, kind: TransactionKind): Promise<Types.ObjectId[]> {
    const rows = await this.transactions.find({ member_id: memberId, kind }, { _id: 1 }).maxTimeMS(5000)
      .lean<{ _id: Types.ObjectId }[]>().exec();
    return rows.map(row => row._id);
  }

  findOwnTransactionsByIds(memberId: Types.ObjectId, ids: Types.ObjectId[]): Promise<Transaction[]> {
    return this.transactions.find({ _id: { $in: ids }, member_id: memberId }).maxTimeMS(5000).lean<Transaction[]>().exec();
  }

  // ----- payments, invoices: chỉ gọi sau khi transaction đã được xác nhận là của member -----

  // Trạng thái khoản thu cần lấy do service quyết định.
  findPaymentByStatus(transactionId: Types.ObjectId, status: PaymentStatus): Promise<Payment | null> {
    return this.payments.findOne({ transaction_id: transactionId, status }).maxTimeMS(5000).lean<Payment>().exec();
  }

  findInvoiceByTransaction(transactionId: Types.ObjectId): Promise<Invoice | null> {
    return this.invoices.findOne({ transaction_id: transactionId }).maxTimeMS(5000).lean<Invoice>().exec();
  }

  findInvoiceById(id: Types.ObjectId): Promise<Invoice | null> {
    return this.invoices.findById(id).maxTimeMS(5000).lean<Invoice>().exec();
  }
}
