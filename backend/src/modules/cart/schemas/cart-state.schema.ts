// Tầng dữ liệu (US-40 bước 1): cấu trúc collection cart_states – version chung của toàn giỏ, một document mỗi Member.
// _id chính là member_id; chỉ tạo khi mutation đầu tiên thành công, GET khi chưa có state coi như version 0 (US-40-C01).
import { Schema, Types } from 'mongoose';

export interface CartState {
  _id: Types.ObjectId;
  version: number;
  created_at: Date;
  updated_at: Date;
}

export const CartStateSchema = new Schema<CartState>({
  // _id = member_id: index _id mặc định đã unique nên mỗi Member chỉ có một state (US-40-TC03).
  _id: { type: Schema.Types.ObjectId, ref: 'Member', required: true },
  // US-40-C01, US-40-TC03: version Int32 ≥ 0, tăng 1 sau mỗi mutation thành công.
  version: { type: Schema.Types.Int32, required: true, validate: (value: number) => Number.isInteger(value) && value >= 0 },
}, { collection: 'cart_states', versionKey: false, strict: 'throw', timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });
