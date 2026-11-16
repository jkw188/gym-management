import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { ClientSession } from 'mongodb';
import { Types } from 'mongoose';
import { ApplicationError } from '../../common/errors/application-error';
import { ServerClock } from '../../common/utils/business-date';
import { normalizeFullName, normalizePhone } from '../../common/utils/normalization';
import { fromVndDecimal, normalizeVnd } from '../../common/utils/vnd-money';
import { TransactionRunner } from '../../infrastructure/transaction/transaction-runner';
import { RetailCategory, RetailInventory, RetailProduct } from '../catalog/retail-catalog.schema';
import { validBalance } from '../inventory/inventory-writer';
import { Member } from '../members/schemas/member.schema';
import { OrdersRepository } from './orders.repository';
import { PosPreviewDto, PosProductQueryDto } from './pos.dto';

export const retailConflict = (code: string, message: string) => new ApplicationError(409, code, message);
export function normalizePos(input: PosPreviewDto) {
  return { memberId: input.memberId?.toLowerCase(), buyerName: input.buyerName === undefined ? undefined : normalizeFullName(input.buyerName),
    recipientPhone: input.recipientPhone === undefined ? undefined : normalizePhone(input.recipientPhone), preferredPaymentMethod: input.preferredPaymentMethod,
    items: input.items.map(item => ({ productId: item.productId.toLowerCase(), quantity: item.quantity })).sort((a, b) => a.productId.localeCompare(b.productId)) };
}
export type RetailIntent = ReturnType<typeof normalizePos>;
export interface QuotedItem { productId: string; quantity: number; productVersion: number; unitPrice: string; lineTotal: string; sku: string; name: string }
interface RetailQuote { purpose: string; actorId: string; memberId?: string; channel: string;
  items: Pick<QuotedItem, 'productId' | 'quantity' | 'productVersion' | 'unitPrice'>[]; total: string }

@Injectable()
export class RetailQuoteService {
  constructor(private readonly repository: OrdersRepository, private readonly transactions: TransactionRunner,
    private readonly config: ConfigService, private readonly jwt: JwtService, private readonly clock: ServerClock) {}
  private secret() {
    const secret = this.config.get<string>('RETAIL_QUOTE_SECRET');
    if (!secret || Buffer.byteLength(secret) < 32 || secret === this.config.get<string>('jwtAccessSecret')) {
      throw new ApplicationError(503, 'RETAIL_NOT_READY', 'Cần cấu hình RETAIL_QUOTE_SECRET riêng tối thiểu 32 byte');
    }
    return secret;
  }
  pickupLocation() {
    const location = this.config.get<string>('PICKUP_LOCATION')?.trim();
    if (!location) throw new ApplicationError(503, 'RETAIL_NOT_READY', 'Cần cấu hình PICKUP_LOCATION thực tế');
    return location;
  }
  async buyer(intent: RetailIntent, session: ClientSession) {
    if (!intent.memberId) return { name: intent.buyerName ?? 'Khách lẻ', phone: intent.recipientPhone ?? '' };
    const member = await this.repository.connection.db!.collection<Member>('members').findOne({ _id: new Types.ObjectId(intent.memberId) }, { session });
    if (!member) throw new ApplicationError(404, 'NOT_FOUND', 'Không tìm thấy hội viên');
    return { name: member.full_name, phone: member.phone };
  }
  async price(items: RetailIntent['items'], session: ClientSession): Promise<{ items: QuotedItem[]; total: string }> {
    const db = this.repository.connection.db!, result: QuotedItem[] = [];
    let total = 0n;
    for (const item of items) {
      const product = await db.collection<RetailProduct>('products').findOne({ _id: new Types.ObjectId(item.productId) }, { session });
      const category = product ? await db.collection<RetailCategory>('categories').findOne({ _id: product.category_id }, { session }) : null;
      if (product?.status !== 'ACTIVE' || category?.status !== 'ACTIVE') throw retailConflict('PRODUCT_UNAVAILABLE', 'Sản phẩm hoặc danh mục đã ngừng bán');
      const balance = await db.collection<RetailInventory>('inventory').findOne({ product_id: product._id }, { session });
      if (!validBalance(balance)) throw retailConflict('INVENTORY_INTEGRITY_ERROR', 'Tồn kho cần được đối chiếu');
      if (balance!.on_hand - balance!.reserved < item.quantity) throw retailConflict('INSUFFICIENT_STOCK', 'Không đủ tồn khả dụng');
      const unitPrice = fromVndDecimal(product.price), lineTotal = normalizeVnd((BigInt(unitPrice) * BigInt(item.quantity)).toString());
      total += BigInt(lineTotal);
      result.push({ ...item, productVersion: product.version, unitPrice, lineTotal, sku: product.sku, name: product.name });
    }
    return { items: result, total: normalizeVnd(total.toString()) };
  }
  async preview(actorId: string, input: PosPreviewDto) {
    const intent = normalizePos(input), secret = this.secret(), pickupLocation = this.pickupLocation();
    return this.transactions.run(async session => {
      const buyer = await this.buyer(intent, session), priced = await this.price(intent.items, session), now = this.clock.now();
      const iat = Math.floor(now.getTime() / 1000), exp = iat + 600;
      // Q01 excludes contact data and names from the signed quote.
      const quoteToken = await this.jwt.signAsync({ purpose: 'RETAIL_QUOTE_V1', actorId, memberId: intent.memberId, channel: 'POS',
        items: priced.items.map(({ productId, quantity, productVersion, unitPrice }) => ({ productId, quantity, productVersion, unitPrice })), total: priced.total, iat, exp },
      { secret, algorithm: 'HS256', audience: 'retail-order-quote' });
      return { ...priced, buyer, quoteToken, quoteExpiresAt: new Date(exp * 1000).toISOString(), pickupLocation,
        expiryPreview: { durationHours: 24, startsAt: 'CREATE' }, asOf: now.toISOString() };
    });
  }
  async verify(token: string, actorId: string, intent: RetailIntent, priced: { items: QuotedItem[]; total: string }) {
    let quote: RetailQuote;
    try { quote = await this.jwt.verifyAsync<RetailQuote>(token, { secret: this.secret(), algorithms: ['HS256'], audience: 'retail-order-quote', clockTimestamp: Math.floor(this.clock.now().getTime() / 1000) }); }
    catch (error) {
      if (error instanceof ApplicationError) throw error;
      if (error instanceof Error && error.name === 'TokenExpiredError') throw retailConflict('QUOTE_EXPIRED', 'Báo giá hết hạn; cần xem và xác nhận lại');
      throw new ApplicationError(400, 'INVALID_QUOTE', 'Báo giá không hợp lệ');
    }
    if (quote.purpose !== 'RETAIL_QUOTE_V1') throw new ApplicationError(400, 'INVALID_QUOTE', 'Báo giá không hợp lệ');
    if (quote.actorId !== actorId) throw new ApplicationError(403, 'FORBIDDEN', 'Báo giá không thuộc người lập đơn');
    const expected = priced.items.map(({ productId, quantity, productVersion, unitPrice }) => ({ productId, quantity, productVersion, unitPrice }));
    if (quote.channel !== 'POS' || quote.memberId !== intent.memberId || quote.total !== priced.total || JSON.stringify(quote.items) !== JSON.stringify(expected)) {
      throw retailConflict('QUOTE_STALE', 'Sản phẩm, số lượng hoặc giá đã thay đổi; cần xác nhận báo giá mới');
    }
  }
  async products(query: PosProductQueryDto) {
    const literal = query.q ? new RegExp(query.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') : undefined;
    const [result] = await this.repository.connection.db!.collection('products').aggregate<{ items: { _id: Types.ObjectId; sku: string; name: string; price: Types.Decimal128; version: number; available: number; categoryId: Types.ObjectId }[]; count: { total: number }[] }>([
      { $match: { status: 'ACTIVE', ...(query.categoryId ? { category_id: new Types.ObjectId(query.categoryId) } : {}), ...(literal ? { $or: [{ sku: literal }, { name: literal }] } : {}) } },
      { $lookup: { from: 'categories', localField: 'category_id', foreignField: '_id', as: 'category' } },
      { $match: { 'category.status': 'ACTIVE' } },
      { $lookup: { from: 'inventory', localField: '_id', foreignField: 'product_id', as: 'balance' } }, { $unwind: '$balance' },
      { $project: { sku: 1, name: 1, price: 1, version: 1, categoryId: '$category_id', available: { $subtract: ['$balance.on_hand', '$balance.reserved'] } } },
      { $sort: { name: 1, _id: 1 } }, { $facet: { items: [{ $skip: (query.page - 1) * query.limit }, { $limit: query.limit }], count: [{ $count: 'total' }] } },
    ], { maxTimeMS: 5000 }).toArray();
    const total = result.count[0]?.total ?? 0;
    return { items: result.items.map(row => ({ id: String(row._id), sku: row.sku, name: row.name, categoryId: String(row.categoryId),
      price: fromVndDecimal(row.price), productVersion: row.version, available: Math.max(0, row.available) })), total, page: query.page, limit: query.limit, totalPages: Math.ceil(total / query.limit) };
  }
}
