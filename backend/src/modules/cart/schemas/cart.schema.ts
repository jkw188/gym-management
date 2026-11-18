// Tầng dữ liệu (US-40 bước 1): cấu trúc collection carts, mỗi document là một dòng giỏ của một Member cho một sản phẩm.
// Giỏ không lưu giá hay tổng tiền: giá luôn đọc lại từ products lúc GET (US-40-F04, US-40-TC07).
import { Schema, Types } from 'mongoose';

// US-40-F02: mỗi dòng có số lượng 1–999.
export const CART_QUANTITY_MIN = 1;
export const CART_QUANTITY_MAX = 999;

export interface CartLine {
  _id: Types.ObjectId;
  member_id: Types.ObjectId;
  product_id: Types.ObjectId;
  quantity: number;
  created_at: Date;
  updated_at: Date;
}

export const CartSchema = new Schema<CartLine>({
  member_id: { type: Schema.Types.ObjectId, ref: 'Member', required: true, immutable: true },
  product_id: { type: Schema.Types.ObjectId, ref: 'Product', required: true, immutable: true },
  // US-40-TC04: quantity Int32, số nguyên 1–999; không lưu dòng 0 (xóa dòng dùng DELETE).
  // Int32 của Mongoose không có min/max nên kiểm khoảng trong validate (giống trainer-review.schema.ts).
  quantity: { type: Schema.Types.Int32, required: true,
    validate: (value: number) => Number.isInteger(value) && value >= CART_QUANTITY_MIN && value <= CART_QUANTITY_MAX },
  // strict: 'throw' – field lạ như unit_price bị báo lỗi thay vì bị bỏ đi âm thầm.
}, { collection: 'carts', versionKey: false, strict: 'throw', timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

// US-40-TC01: mỗi member/product chỉ một dòng.
CartSchema.index({ member_id: 1, product_id: 1 }, { unique: true, name: 'carts_member_product_unique' });
// US-40-TC01: trả dòng theo thứ tự thêm (createdAt rồi id). Không unique product_id một mình vì nhiều Member cùng chọn một SKU.
CartSchema.index({ member_id: 1, created_at: 1, _id: 1 }, { name: 'carts_member_created' });
