// Tầng nghiệp vụ (US-40 bước 2): toàn bộ luật giỏ hàng của Member – xem giỏ, thêm, đặt số lượng, xóa dòng.
// Lệnh ghi: kiểm chủ giỏ → Idempotency-Key (EN-02) → khóa catalog_state rồi members (S05-C01) → CAS version cart_states
// → kiểm bán/tồn/tổng → ghi dòng + version + operation_requests trong MỘT transaction. Giỏ KHÔNG giữ tồn (US-40-F03).
import { Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import { ClientSession } from 'mongodb';
import { Types } from 'mongoose';
import { ApplicationError } from '../../common/errors/application-error';
import { VND_MAX } from '../../common/utils/vnd-money';
import { DataGuardsService } from '../../infrastructure/transaction/data-guards.service';
import { TransactionRunner } from '../../infrastructure/transaction/transaction-runner';
import { IdempotencyService } from '../operations/idempotency.service';
import { Operation } from '../operations/schemas/operation-request.schema';
import { CartOwnerResolver } from './cart-owner.resolver';
import { CartRepository } from './cart.repository';
import {
  CartCategoryRow, CartInventoryRow, CartItemResponse, CartLineReason, CartLineRow, CartProductRow, CartResponse, CartTotalsState,
} from './cart.types';
import { CART_QUANTITY_MAX } from './schemas/cart.schema';

// US-40-F02: tối đa 100 SKU mỗi giỏ.
const CART_LINES_MAX = 100;

// ---------- Lỗi nghiệp vụ (mã theo bảng "400 / 409 nghiệp vụ" của spec) ----------
const profileRequired = () => new ApplicationError(409, 'MEMBER_PROFILE_REQUIRED', 'Tài khoản chưa được liên kết hồ sơ hội viên');
const versionConflict = () => new ApplicationError(409, 'CART_VERSION_CONFLICT', 'Giỏ hàng đã thay đổi, vui lòng tải lại');
const itemNotFound = () => new ApplicationError(404, 'CART_ITEM_NOT_FOUND', 'Sản phẩm không có trong giỏ');
const productNotFound = () => new ApplicationError(404, 'PRODUCT_NOT_FOUND', 'Không tìm thấy sản phẩm');
const quantityInvalid = () => new ApplicationError(400, 'QUANTITY_INVALID', `Số lượng mỗi dòng từ 1 đến ${CART_QUANTITY_MAX}`);
const cartLimit = () => new ApplicationError(400, 'CART_LIMIT_EXCEEDED', `Giỏ hàng tối đa ${CART_LINES_MAX} sản phẩm`);
const amountLimit = () => new ApplicationError(400, 'AMOUNT_LIMIT_EXCEEDED', 'Tổng tiền giỏ vượt mức cho phép');
const LINE_ERRORS: Record<CartLineReason, () => ApplicationError> = {
  PRODUCT_UNAVAILABLE: () => new ApplicationError(409, 'PRODUCT_UNAVAILABLE', 'Sản phẩm đang ngừng bán'),
  INVENTORY_UNAVAILABLE: () => new ApplicationError(409, 'INVENTORY_UNAVAILABLE', 'Chưa có thông tin tồn kho của sản phẩm'),
  INSUFFICIENT_STOCK: () => new ApplicationError(409, 'INSUFFICIENT_STOCK', 'Số lượng vượt quá tồn kho hiện có'),
};

// Ảnh chụp catalog của các sản phẩm trong giỏ, đọc trong cùng session.
interface CatalogView {
  products: Map<string, CartProductRow>;
  categories: Map<string, CartCategoryRow>;
  inventories: Map<string, CartInventoryRow>;
}

// Kết quả kiểm một dòng với số lượng cho trước.
interface LineCheck {
  product: CartProductRow | null;
  price: Decimal | null;      // null = thiếu sản phẩm hoặc giá không tính được
  available: number | null;   // null = thiếu/lỗi inventory
  reasons: CartLineReason[];
}

// Phần riêng của từng lệnh ghi, chạy SAU khi đã khóa và kiểm version.
interface MutationContext {
  session: ClientSession;
  memberId: Types.ObjectId;
  lines: CartLineRow[];
}

@Injectable()
export class CartService {
  constructor(
    private readonly repository: CartRepository,
    private readonly owners: CartOwnerResolver,
    private readonly idempotency: IdempotencyService,
    private readonly guards: DataGuardsService,
    private readonly transactions: TransactionRunner,
  ) {}

  // GET /api/me/cart – chỉ đọc, không tạo state/dòng (US-40-TC03).
  async getCart(accountId: string): Promise<CartResponse> {
    const asOf = new Date().toISOString();
    const owner = await this.owners.resolve(accountId);
    // US-40-F01, US-40-TC03: chưa liên kết → giỏ rỗng có cờ, không tự tạo hay link hồ sơ.
    if (!owner.memberLinked) {
      return { memberLinked: false, reason: owner.reason, version: 0, items: [], subtotal: '0', totalsState: 'OK',
        readyForOrder: false, canCheckout: false, asOf };
    }
    const memberId = new Types.ObjectId(owner.memberId);

    // US-40 mục 3: cart/product/category/inventory đọc trong CÙNG một snapshot transaction, không ghép query rời.
    return this.transactions.run(async session => {
      const version = (await this.repository.findVersion(memberId, session)) ?? 0;
      const lines = await this.repository.findLines(memberId, session);
      const view = await this.loadCatalog(lines.map(line => line.product_id), session);

      const items = lines.map(line => this.toItem(line, view));
      const { subtotal, totalsState } = this.totalOf(lines.map(line => ({ quantity: line.quantity, price: this.checkLine(line.product_id, line.quantity, view).price })));
      // US-40-F05: readyForOrder chỉ là gợi ý – có ít nhất 1 dòng, mọi dòng hợp lệ và tổng trong trần.
      const readyForOrder = items.length > 0 && items.every(item => item.lineState === 'OK') && totalsState === 'OK';
      return { memberLinked: true, version, items, subtotal, totalsState, readyForOrder, canCheckout: false, asOf };
    });
  }

  // POST /api/me/cart/items – quantity là lượng THÊM (US-40-F02).
  async addItem(accountId: string, key: string, input: { version: number; productId: string; quantity: number }) {
    const productId = new Types.ObjectId(input.productId);
    const payload = { version: input.version, productId: productId.toHexString(), quantity: input.quantity };

    return this.mutate(accountId, 'CART_ADD_ITEM', key, payload, undefined, input.version, 201, async ({ session, memberId, lines }) => {
      const existing = lines.find(line => line.product_id.equals(productId));
      const view = await this.loadCatalog([...lines.map(line => line.product_id), productId], session);
      // US-40-TC04: productId đúng định dạng nhưng không tồn tại → 404.
      if (!existing && !view.products.has(productId.toHexString())) throw productNotFound();

      // US-40-TC04: tổng sau khi cộng > 999 → 400.
      const quantity = (existing?.quantity ?? 0) + input.quantity;
      if (quantity > CART_QUANTITY_MAX) throw quantityInvalid();
      // US-40-TC04: SKU mới khi giỏ đã đủ 100 dòng → 400; cộng vào SKU đã có vẫn được.
      if (!existing && lines.length >= CART_LINES_MAX) throw cartLimit();

      // US-40-TC05, TC08: thêm luôn là tăng → kiểm bán/tồn và trần tổng tiền.
      this.assertCanIncrease(productId, quantity, lines, view);
      await this.repository.saveLine(memberId, productId, quantity, session);
      return { productId: productId.toHexString(), quantity };
    });
  }

  // PUT /api/me/cart/items/:productId – quantity là số TUYỆT ĐỐI, chỉ dòng đã có (không upsert ngầm).
  async setItem(accountId: string, key: string, productIdText: string, input: { version: number; quantity: number }) {
    const productId = new Types.ObjectId(productIdText);
    const payload = { version: input.version, quantity: input.quantity };

    return this.mutate(accountId, 'CART_SET_ITEM', key, payload, productId.toHexString(), input.version, 200, async ({ session, memberId, lines }) => {
      const existing = lines.find(line => line.product_id.equals(productId));
      // US-40-TC01, TC02: dòng không có trong giỏ CỦA MÌNH → 404.
      if (!existing) throw itemNotFound();

      // US-40-F02, US-40-TC06: giảm lượng luôn được (kể cả dòng lỗi bán/tồn hoặc giỏ vượt trần) để Member dọn giỏ.
      // Giữ nguyên hoặc tăng thì phải kiểm lại như thêm (US-40-TC05).
      if (input.quantity >= existing.quantity) {
        const view = await this.loadCatalog(lines.map(line => line.product_id), session);
        this.assertCanIncrease(productId, input.quantity, lines, view);
      }
      await this.repository.saveLine(memberId, productId, input.quantity, session);
      return { productId: productId.toHexString(), quantity: input.quantity };
    });
  }

  // DELETE /api/me/cart/items/:productId?version= – luôn cho chủ giỏ xóa khi version đúng (US-40-F02).
  async removeItem(accountId: string, key: string, productIdText: string, version: number) {
    const productId = new Types.ObjectId(productIdText);

    return this.mutate(accountId, 'CART_REMOVE_ITEM', key, { version }, productId.toHexString(), version, 200, async ({ session, memberId, lines }) => {
      // US-40-TC03, TC10: dòng không có (hoặc đã xóa bằng key khác) → 404, không tạo state rỗng giả.
      if (!lines.some(line => line.product_id.equals(productId))) throw itemNotFound();
      await this.repository.deleteLine(memberId, productId, session);
      return { removedProductId: productId.toHexString() };
    });
  }

  // ---------- Khung chung của mọi lệnh ghi ----------

  // Thứ tự: chủ giỏ → key (replay tìm TRƯỚC khi kiểm version cũ, US-40-C01) → khóa → version → work → tăng version.
  private async mutate(
    accountId: string, operation: Operation, key: string, payload: Record<string, unknown>, targetId: string | undefined,
    clientVersion: number, status: number, work: (context: MutationContext) => Promise<Record<string, unknown>>,
  ): Promise<Record<string, unknown>> {
    // US-40-F01, US-40-TC03: chưa liên kết → 409, không ghi gì (kể cả operation_requests).
    const owner = await this.owners.resolve(accountId);
    if (!owner.memberLinked) throw profileRequired();
    const memberId = new Types.ObjectId(owner.memberId);

    // EN-02, US-40-TC10, TC11: cùng key + cùng payload → trả lại HTTP/body gốc; khác payload → 409 IDEMPOTENCY_CONFLICT.
    // TC13: work lỗi thì dòng, state và operation_requests cùng rollback.
    const result = await this.idempotency.execute({ actorId: accountId, operation, clientKey: key, payload, targetId }, async session => {
      // S05-C01: khóa catalog_state TRƯỚC members.service_revision (cùng thứ tự với Admin sửa catalog và checkout S06).
      await this.guards.acquire(session, { catalog: true, members: [memberId] });

      // US-40-C01, US-40-TC09: version gửi lên phải bằng version hiện tại; giỏ chưa có state coi như 0.
      const current = await this.repository.findVersion(memberId, session);
      if (clientVersion !== (current ?? 0)) throw versionConflict();

      const lines = await this.repository.findLines(memberId, session);
      const body = await work({ session, memberId, lines });

      // US-40-C01: dòng và version+1 cùng transaction. State chỉ tạo ở mutation đầu tiên thành công.
      if (current === null) await this.repository.createState(memberId, session);
      else if (!(await this.repository.increaseVersion(memberId, current, session))) throw versionConflict();

      const newVersion = (current ?? 0) + 1;
      return { status, body: { version: newVersion, ...body }, resultIds: { memberId, productId: (targetId ?? payload.productId) as string } };
    });
    return result.body;
  }

  // ---------- Luật kiểm dòng và tổng ----------

  // Đọc sản phẩm, danh mục, tồn của các dòng trong cùng session.
  private async loadCatalog(productIds: Types.ObjectId[], session: ClientSession): Promise<CatalogView> {
    const products = await this.repository.findProducts(productIds, session);
    const categories = await this.repository.findCategories(products.map(product => product.category_id), session);
    const inventories = await this.repository.findInventories(productIds, session);
    return {
      products: new Map(products.map(row => [row._id.toHexString(), row])),
      categories: new Map(categories.map(row => [row._id.toHexString(), row])),
      inventories: new Map(inventories.map(row => [row.product_id.toHexString(), row])),
    };
  }

  // US-40-F05: kiểm một dòng với số lượng cho trước, trả về giá hiện tại và các lý do bị chặn.
  private checkLine(productId: Types.ObjectId, quantity: number, view: CatalogView): LineCheck {
    const product = view.products.get(productId.toHexString()) ?? null;
    // US-40-TC08: sản phẩm mất do dữ liệu bất thường → giữ dòng, không có giá.
    if (!product) return { product: null, price: null, available: null, reasons: ['PRODUCT_UNAVAILABLE'] };

    const reasons: CartLineReason[] = [];
    // US-40-TC05: effectiveActive = sản phẩm ACTIVE và danh mục ACTIVE (US-34).
    const category = view.categories.get(product.category_id.toHexString());
    if (product.status !== 'ACTIVE' || category?.status !== 'ACTIVE') reasons.push('PRODUCT_UNAVAILABLE');

    const available = availableOf(view.inventories.get(productId.toHexString()));
    if (available === null) reasons.push('INVENTORY_UNAVAILABLE');
    else if (quantity > available) reasons.push('INSUFFICIENT_STOCK');

    return { product, price: priceOf(product.price), available, reasons };
  }

  // Thêm hoặc đặt số lượng không giảm: dòng phải bán được, đủ tồn, và tổng giỏ sau khi đổi trong trần tiền.
  private assertCanIncrease(productId: Types.ObjectId, quantity: number, lines: CartLineRow[], view: CatalogView): void {
    const check = this.checkLine(productId, quantity, view);
    // US-40-TC05: báo lý do đầu tiên (ngừng bán → thiếu inventory → vượt tồn).
    if (check.reasons.length > 0) throw LINE_ERRORS[check.reasons[0]]();

    // US-40-TC08: tính tổng với số lượng mới của dòng này; dòng khác giữ nguyên.
    const proposed = lines.filter(line => !line.product_id.equals(productId)).map(line => ({
      quantity: line.quantity, price: this.checkLine(line.product_id, line.quantity, view).price,
    }));
    proposed.push({ quantity, price: check.price });
    if (this.totalOf(proposed).totalsState === 'OVER_LIMIT') throw amountLimit();
  }

  // US-40-F04: tổng bằng Decimal (không dùng Number float). Có dòng thiếu giá → UNAVAILABLE; vượt trần → OVER_LIMIT.
  private totalOf(lines: { quantity: number; price: Decimal | null }[]): { subtotal: string | null; totalsState: CartTotalsState } {
    let sum = new Decimal(0);
    let overLimit = false;
    for (const line of lines) {
      if (line.price === null) return { subtotal: null, totalsState: 'UNAVAILABLE' };
      const lineTotal = line.price.times(line.quantity);
      if (lineTotal.gt(VND_MAX)) overLimit = true;
      sum = sum.plus(lineTotal);
    }
    if (overLimit || sum.gt(VND_MAX)) return { subtotal: null, totalsState: 'OVER_LIMIT' };
    return { subtotal: sum.toFixed(0), totalsState: 'OK' };
  }

  // Đổi một dòng giỏ thành dữ liệu trả về; dòng lỗi vẫn giữ productId/quantity (US-40-F05).
  private toItem(line: CartLineRow, view: CatalogView): CartItemResponse {
    const check = this.checkLine(line.product_id, line.quantity, view);
    const lineTotal = check.price?.times(line.quantity) ?? null;
    return {
      productId: line.product_id.toHexString(),
      sku: check.product?.sku ?? null,
      name: check.product?.name ?? null,
      imageUrl: check.product?.image_url ?? null,
      quantity: line.quantity,
      unitPrice: check.price?.toFixed(0) ?? null,
      // Thành tiền một dòng vượt trần thì không trả số (tổng giỏ báo OVER_LIMIT).
      lineTotal: lineTotal && lineTotal.lte(VND_MAX) ? lineTotal.toFixed(0) : null,
      availableQuantity: check.product ? check.available : null,
      productVersion: check.product?.version ?? null,
      lineState: check.reasons.length === 0 ? 'OK' : 'BLOCKED',
      reasons: check.reasons,
    };
  }
}

// US-40-F05, giống US-35: tồn thiếu, không phải số nguyên, âm hoặc reserved > on_hand → không dùng được (null).
function availableOf(inventory: CartInventoryRow | undefined): number | null {
  if (!inventory) return null;
  const { on_hand: onHand, reserved } = inventory;
  if (typeof onHand !== 'number' || typeof reserved !== 'number') return null;
  if (!Number.isInteger(onHand) || !Number.isInteger(reserved) || onHand < 0 || reserved < 0 || reserved > onHand) return null;
  return onHand - reserved;
}

// US-40-F04: giá Decimal128 → Decimal; chỉ nhận số nguyên VND 0..999999999999, sai thì null (dòng không tính được tiền).
function priceOf(value: unknown): Decimal | null {
  if (value === null || value === undefined) return null;
  const text = String(value);
  if (!/^\d+$/.test(text)) return null;
  const price = new Decimal(text);
  return price.gt(VND_MAX) ? null : price;
}
