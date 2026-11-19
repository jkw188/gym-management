// Tầng kiểu dữ liệu (US-40 bước 2): type dùng chung của module giỏ – dữ liệu đọc từ DB và dữ liệu trả về cho Member.
// Không có field giá vốn/on_hand/reserved trong response (US-40-TC07).
import { Types } from 'mongoose';

// ---------- Dữ liệu đọc từ DB (repository trả về) ----------

// Một dòng giỏ đã lưu.
export interface CartLineRow {
  _id: Types.ObjectId;
  product_id: Types.ObjectId;
  quantity: number;
}

// Các field sản phẩm giỏ cần; price là Decimal128 trong products.
export interface CartProductRow {
  _id: Types.ObjectId;
  category_id: Types.ObjectId;
  sku: string;
  name: string;
  image_url?: string;
  price: unknown;
  status: string;
  version: number;
}

export interface CartCategoryRow {
  _id: Types.ObjectId;
  status: string;
}

export interface CartInventoryRow {
  product_id: Types.ObjectId;
  on_hand: unknown;
  reserved: unknown;
}

// ---------- Dữ liệu trả về (API) ----------

// US-40-F05: lý do một dòng bị chặn.
export type CartLineReason = 'PRODUCT_UNAVAILABLE' | 'INVENTORY_UNAVAILABLE' | 'INSUFFICIENT_STOCK';
export type CartLineState = 'OK' | 'BLOCKED';
// US-40-F04: OK = tính được tổng; UNAVAILABLE = có dòng thiếu sản phẩm/giá; OVER_LIMIT = vượt trần tiền.
export type CartTotalsState = 'OK' | 'UNAVAILABLE' | 'OVER_LIMIT';

export interface CartItemResponse {
  productId: string;
  sku: string | null;
  name: string | null;
  imageUrl: string | null;
  quantity: number;
  unitPrice: string | null;
  lineTotal: string | null;
  // Chỉ chủ giỏ thấy, để biết sửa số lượng tối đa bao nhiêu.
  availableQuantity: number | null;
  productVersion: number | null;
  lineState: CartLineState;
  reasons: CartLineReason[];
}

export interface CartResponse {
  memberLinked: boolean;
  // Chỉ có khi chưa liên kết hồ sơ (US-40-F01).
  reason?: 'MEMBER_PROFILE_REQUIRED';
  version: number;
  items: CartItemResponse[];
  subtotal: string | null;
  totalsState: CartTotalsState;
  readyForOrder: boolean;
  // US-40-F05: luôn false trong Sprint 5 vì chưa có US-41.
  canCheckout: false;
  asOf: string;
}
