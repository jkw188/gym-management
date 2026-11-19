// Tầng nghiệp vụ (US-41/US-53): báo giá bán lẻ – tính giá ở server, ký quoteToken (JWT HS256, secret riêng) và kiểm lại quote khi tạo đơn.
// Preview chỉ đọc: không ghi cart/order/reserved (US-41-Q01). Dùng chung cho POS (Staff) và đơn website (Member).
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { ClientSession } from 'mongodb';
import { Types } from 'mongoose';
import { ApplicationError } from '../../common/errors/application-error';
import { ServerClock } from '../../common/utils/business-date';
import { normalizeFullName, normalizePhone } from '../../common/utils/normalization';
import { fromVndDecimal, normalizeVnd, VND_MAX } from '../../common/utils/vnd-money';
import { TransactionRunner } from '../../infrastructure/transaction/transaction-runner';
import { CartRepository } from '../cart/cart.repository';
import { RetailCategory, RetailInventory, RetailProduct } from '../catalog/retail-catalog.schema';
import { validBalance } from '../inventory/inventory-writer';
import { MemberOwnerReader } from '../members/member-owner.reader';
import { Member } from '../members/schemas/member.schema';
import { OrdersRepository } from './orders.repository';
import { PosPreviewDto, PosProductQueryDto } from './pos.dto';
import { WebsitePreviewDto } from './website-order.dto';

// US-41-F01: giỏ đặt được có 1–100 dòng, mỗi dòng 1–999.
const ORDER_LINES_MAX = 100;
const ORDER_QUANTITY_MAX = 999;
// US-41-Q01: quote hết hạn sau 10 phút.
const QUOTE_SECONDS = 600;

export const retailConflict = (code: string, message: string) => new ApplicationError(409, code, message);
export function normalizePos(input: PosPreviewDto) {
  return { memberId: input.memberId?.toLowerCase(), buyerName: input.buyerName === undefined ? undefined : normalizeFullName(input.buyerName),
    recipientPhone: input.recipientPhone === undefined ? undefined : normalizePhone(input.recipientPhone), preferredPaymentMethod: input.preferredPaymentMethod,
    items: input.items.map(item => ({ productId: item.productId.toLowerCase(), quantity: item.quantity })).sort((a, b) => a.productId.localeCompare(b.productId)) };
}
export type RetailIntent = ReturnType<typeof normalizePos>;
export interface QuotedItem { productId: string; quantity: number; productVersion: number; unitPrice: string; lineTotal: string; sku: string; name: string }
interface RetailQuote { purpose: string; actorId: string; memberId?: string; channel: string; cartVersion?: number;
  items: Pick<QuotedItem, 'productId' | 'quantity' | 'productVersion' | 'unitPrice'>[]; total: string }
// Những gì quote phải khớp ngoài giá: kênh, hội viên và (với WEBSITE) version giỏ đã xem.
export interface QuoteExpectation { channel: 'POS' | 'WEBSITE'; memberId?: string; cartVersion?: number }
// Giỏ đã đọc lại trong transaction: version hiện tại và các dòng (sắp theo productId, giống thứ tự trong quote).
export interface WebsiteCart { version: number; items: { productId: string; quantity: number }[] }

@Injectable()
export class RetailQuoteService {
  constructor(private readonly repository: OrdersRepository, private readonly transactions: TransactionRunner,
    private readonly config: ConfigService, private readonly jwt: JwtService, private readonly clock: ServerClock,
    private readonly carts: CartRepository, private readonly memberOwner: MemberOwnerReader) {}
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
      const unitPrice = fromVndDecimal(product.price);
      const line = BigInt(unitPrice) * BigInt(item.quantity);
      total += line;
      // US-41-TC04: tổng dòng hoặc tổng đơn vượt 999999999999 → 409 AMOUNT_LIMIT_EXCEEDED (không phải lỗi định dạng 400).
      if (line > BigInt(VND_MAX) || total > BigInt(VND_MAX)) throw retailConflict('AMOUNT_LIMIT_EXCEEDED', 'Tổng tiền đơn vượt mức cho phép');
      result.push({ ...item, productVersion: product.version, unitPrice, lineTotal: normalizeVnd(line.toString()), sku: product.sku, name: product.name });
    }
    return { items: result, total: normalizeVnd(total.toString()) };
  }

  // US-41-Q01: ký quote HS256 bằng RETAIL_QUOTE_SECRET, aud retail-order-quote, purpose RETAIL_QUOTE_V1, hết hạn sau 10 phút.
  // Payload chỉ có id, số lượng, version, giá; không có tên hay số điện thoại.
  private async signQuote(actorId: string, expected: QuoteExpectation, priced: { items: QuotedItem[]; total: string }, now: Date) {
    const iat = Math.floor(now.getTime() / 1000), exp = iat + QUOTE_SECONDS;
    const items = priced.items.map(({ productId, quantity, productVersion, unitPrice }) => ({ productId, quantity, productVersion, unitPrice }));
    const quoteToken = await this.jwt.signAsync({ purpose: 'RETAIL_QUOTE_V1', actorId, memberId: expected.memberId, channel: expected.channel,
      cartVersion: expected.cartVersion, items, total: priced.total, iat, exp }, { secret: this.secret(), algorithm: 'HS256', audience: 'retail-order-quote' });
    return { quoteToken, quoteExpiresAt: new Date(exp * 1000).toISOString() };
  }
  async preview(actorId: string, input: PosPreviewDto) {
    const intent = normalizePos(input), pickupLocation = this.pickupLocation();
    this.secret(); // Thiếu secret → 503 trước khi đọc DB.
    return this.transactions.run(async session => {
      const buyer = await this.buyer(intent, session), priced = await this.price(intent.items, session), now = this.clock.now();
      const quote = await this.signQuote(actorId, { channel: 'POS', memberId: intent.memberId }, priced, now);
      return { ...priced, buyer, ...quote, pickupLocation,
        expiryPreview: { durationHours: 24, startsAt: 'CREATE' }, asOf: now.toISOString() };
    });
  }

  // ---------- Đơn website của Member (US-41) ----------

  // US-41-F01, US-41-TC02: chủ thể lấy từ members.account_id của account đang đăng nhập; chưa liên kết → 409.
  async memberOf(accountId: string): Promise<Types.ObjectId> {
    const memberId = await this.memberOwner.findMemberIdOfAccount(accountId);
    if (!memberId) throw new ApplicationError(409, 'MEMBER_PROFILE_REQUIRED', 'Tài khoản chưa được liên kết hồ sơ hội viên');
    return memberId;
  }

  // Đọc lại giỏ trong transaction và kiểm điều kiện đặt: đúng version, không trống, đúng trần dòng/số lượng.
  async websiteCart(memberId: Types.ObjectId, cartVersion: number, session: ClientSession): Promise<WebsiteCart> {
    const version = (await this.carts.findVersion(memberId, session)) ?? 0;
    // US-41-TC03: giỏ đã đổi sau khi người dùng xem → 409, người dùng tải lại giỏ.
    if (version !== cartVersion) throw retailConflict('CART_VERSION_CONFLICT', 'Giỏ hàng đã thay đổi, vui lòng tải lại');
    const lines = await this.carts.findLines(memberId, session);
    if (lines.length === 0) throw retailConflict('CART_EMPTY', 'Giỏ hàng đang trống');
    // US-41-TC04: dữ liệu giỏ đã lưu vượt trần (ví dụ sửa tay DB) → chặn, không cấp quote.
    const badQuantity = lines.some(line => !Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > ORDER_QUANTITY_MAX);
    if (lines.length > ORDER_LINES_MAX || badQuantity) throw retailConflict('CART_LIMIT_EXCEEDED', 'Giỏ hàng vượt giới hạn số dòng hoặc số lượng');
    const items = lines.map(line => ({ productId: line.product_id.toHexString(), quantity: line.quantity }))
      .sort((a, b) => a.productId.localeCompare(b.productId));
    return { version, items };
  }

  // POST /api/me/orders/preview – US-41-TC01: giá server + quầy nhận + quote 10 phút; chỉ đọc, không giữ tồn.
  async previewWebsite(accountId: string, input: WebsitePreviewDto) {
    const memberId = await this.memberOf(accountId);
    // Thiếu secret hoặc PICKUP_LOCATION → 503 trước khi đọc giỏ (US-41-TC04), không điền địa chỉ giả.
    this.secret();
    const pickupLocation = this.pickupLocation();
    return this.transactions.run(async session => {
      const cart = await this.websiteCart(memberId, input.cartVersion, session);
      // US-41-F02 (1.0.2): preview chặn cùng mã lỗi với create (PRODUCT_UNAVAILABLE, INSUFFICIENT_STOCK...).
      const priced = await this.price(cart.items, session);
      const now = this.clock.now();
      const expected: QuoteExpectation = { channel: 'WEBSITE', memberId: memberId.toHexString(), cartVersion: cart.version };
      const quote = await this.signQuote(accountId, expected, priced, now);
      return { items: priced.items, total: priced.total, ...quote, pickupLocation, asOf: now.toISOString() };
    });
  }

  // US-41-Q01: verify chữ ký/alg/aud/exp trước, rồi purpose, actor; cuối cùng so kênh, hội viên, version giỏ, dòng và tổng với giá hiện tại.
  async verify(token: string, actorId: string, expected: QuoteExpectation, priced: { items: QuotedItem[]; total: string }) {
    let quote: RetailQuote;
    try { quote = await this.jwt.verifyAsync<RetailQuote>(token, { secret: this.secret(), algorithms: ['HS256'], audience: 'retail-order-quote', clockTimestamp: Math.floor(this.clock.now().getTime() / 1000) }); }
    catch (error) {
      if (error instanceof ApplicationError) throw error;
      if (error instanceof Error && error.name === 'TokenExpiredError') throw retailConflict('QUOTE_EXPIRED', 'Báo giá hết hạn; cần xem và xác nhận lại');
      throw new ApplicationError(400, 'INVALID_QUOTE', 'Báo giá không hợp lệ');
    }
    if (quote.purpose !== 'RETAIL_QUOTE_V1') throw new ApplicationError(400, 'INVALID_QUOTE', 'Báo giá không hợp lệ');
    if (quote.actorId !== actorId) throw new ApplicationError(403, 'FORBIDDEN', 'Báo giá không thuộc người lập đơn');
    const items = priced.items.map(({ productId, quantity, productVersion, unitPrice }) => ({ productId, quantity, productVersion, unitPrice }));
    // US-41-TC03: giá, version sản phẩm, số lượng hoặc version giỏ đổi → 409 QUOTE_STALE, không tự thu theo giá mới.
    if (quote.channel !== expected.channel || quote.memberId !== expected.memberId || quote.cartVersion !== expected.cartVersion ||
      quote.total !== priced.total || JSON.stringify(quote.items) !== JSON.stringify(items)) {
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
