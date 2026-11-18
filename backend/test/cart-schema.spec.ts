// Tầng kiểm thử backend (Jest, unit, không cần DB): US-40 bước 1 – cấu trúc carts, cart_states và operation của giỏ.
// Kiểm tra quantity 1–999, version ≥ 0, index một dòng mỗi member/product, không lưu giá trong giỏ (TC01, TC03, TC04, TC07).
// Hợp đồng test đặt ra cho Builder (US-40 bước 1, theo bảng "Schema và cập nhật giỏ đồng thời" mục 2 của spec):
//   CartSchema (src/modules/cart/schemas/cart.schema.ts) – collection carts:
//   - member_id, product_id: ObjectId bắt buộc; quantity: số nguyên 1–999 bắt buộc (không lưu dòng 0).
//   - created_at/updated_at; KHÔNG có unit_price, line_total, subtotal (giá luôn lấy từ products lúc GET).
//   - index unique (member_id, product_id) và index (member_id, created_at, _id); không unique product_id một mình.
//   CartStateSchema (src/modules/cart/schemas/cart-state.schema.ts) – collection cart_states:
//   - _id = member_id (ObjectId); version: số nguyên ≥ 0 bắt buộc; created_at/updated_at.
//   OPERATIONS của operation_requests có thêm CART_ADD_ITEM, CART_SET_ITEM, CART_REMOVE_ITEM.
//   Kiểm bằng validateSync() của Mongoose trên model tạo từ schema (không kết nối DB).
import mongoose, { Types } from 'mongoose';
import { CartSchema } from '../src/modules/cart/schemas/cart.schema';
import { CartStateSchema } from '../src/modules/cart/schemas/cart-state.schema';
import { OPERATIONS } from '../src/modules/operations/schemas/operation-request.schema';

// Model riêng cho test, không đụng model của ứng dụng.
const CartLine = mongoose.model('CartSchemaTestUS40', CartSchema);
const CartState = mongoose.model('CartStateSchemaTestUS40', CartStateSchema);

function validLine(overrides: Record<string, unknown> = {}) {
  return { member_id: new Types.ObjectId(), product_id: new Types.ObjectId(), quantity: 2, ...overrides };
}

const errorPaths = (doc: mongoose.Document) => Object.keys(doc.validateSync()?.errors ?? {});

// Lấy danh sách index khai báo trên schema dưới dạng [fields, options].
const indexes = (schema: mongoose.Schema) => schema.indexes() as Array<[Record<string, unknown>, Record<string, unknown>]>;

describe('US-40 bước 1: cấu trúc carts', () => {
  it('US-40-TC04: dòng giỏ đầy đủ, quantity 1 và 999 → hợp lệ', () => {
    expect(new CartLine(validLine({ quantity: 1 })).validateSync()).toBeUndefined();
    expect(new CartLine(validLine({ quantity: 999 })).validateSync()).toBeUndefined();
  });

  it('US-40-TC04: quantity 0, âm, số lẻ, 1000 hoặc thiếu → lỗi ở quantity (không lưu dòng 0)', () => {
    for (const quantity of [0, -1, 1.5, 1000, undefined]) {
      expect(errorPaths(new CartLine(validLine({ quantity })))).toContain('quantity');
    }
  });

  it('US-40-TC04: thiếu member_id hoặc product_id → lỗi đúng field', () => {
    expect(errorPaths(new CartLine(validLine({ member_id: undefined })))).toContain('member_id');
    expect(errorPaths(new CartLine(validLine({ product_id: undefined })))).toContain('product_id');
  });

  it('US-40-TC01: có index unique (member_id, product_id) → mỗi member/product một dòng', () => {
    const unique = indexes(CartSchema).find(([fields]) => JSON.stringify(fields) === JSON.stringify({ member_id: 1, product_id: 1 }));
    expect(unique).toBeDefined();
    expect(unique![1].unique).toBe(true);
  });

  it('US-40-TC01: có index (member_id, created_at, _id) để trả dòng theo thứ tự thêm', () => {
    const order = indexes(CartSchema).find(([fields]) => JSON.stringify(fields) === JSON.stringify({ member_id: 1, created_at: 1, _id: 1 }));
    expect(order).toBeDefined();
  });

  it('US-40-TC01: KHÔNG có index unique chỉ trên product_id (nhiều Member cùng chọn một SKU)', () => {
    const productOnly = indexes(CartSchema).find(([fields, options]) => JSON.stringify(fields) === JSON.stringify({ product_id: 1 }) && options.unique);
    expect(productOnly).toBeUndefined();
  });

  it('US-40-TC07: carts không có field giá/tổng (unit_price, line_total, subtotal) và có created_at/updated_at', () => {
    for (const path of ['unit_price', 'line_total', 'subtotal', 'price']) {
      expect(CartSchema.path(path)).toBeUndefined();
    }
    expect(CartSchema.path('created_at')).toBeDefined();
    expect(CartSchema.path('updated_at')).toBeDefined();
  });
});

describe('US-40 bước 1: cấu trúc cart_states', () => {
  it('US-40-TC03: state có _id = member_id và version 0 → hợp lệ', () => {
    expect(new CartState({ _id: new Types.ObjectId(), version: 0 }).validateSync()).toBeUndefined();
  });

  it('US-40-TC03: version thiếu, âm hoặc số lẻ → lỗi ở version', () => {
    expect(errorPaths(new CartState({ _id: new Types.ObjectId(), version: undefined }))).toContain('version');
    expect(errorPaths(new CartState({ _id: new Types.ObjectId(), version: -1 }))).toContain('version');
    expect(errorPaths(new CartState({ _id: new Types.ObjectId(), version: 1.5 }))).toContain('version');
  });

  it('US-40-TC03: _id là ObjectId (member_id), có created_at/updated_at', () => {
    expect(CartStateSchema.path('_id').instance).toBe('ObjectId');
    expect(CartStateSchema.path('created_at')).toBeDefined();
    expect(CartStateSchema.path('updated_at')).toBeDefined();
  });
});

describe('US-40 bước 1: operation của giỏ trong operation_requests', () => {
  it('US-40-TC10: OPERATIONS có CART_ADD_ITEM, CART_SET_ITEM, CART_REMOVE_ITEM', () => {
    expect(OPERATIONS).toEqual(expect.arrayContaining(['CART_ADD_ITEM', 'CART_SET_ITEM', 'CART_REMOVE_ITEM']));
  });
});
