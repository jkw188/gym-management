// Tầng dữ liệu (US-40 bước 2): nơi duy nhất đọc/ghi carts, cart_states và đọc products/categories/inventory cho giỏ.
// Mọi hàm nhận session để GET đọc một snapshot và lệnh ghi đọc lại dữ liệu trong CÙNG transaction (US-40-C01).
import { Injectable } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ClientSession } from 'mongodb';
import { Connection, Model, Types } from 'mongoose';
import { CartCategoryRow, CartInventoryRow, CartLineRow, CartProductRow } from './cart.types';
import { CartLine } from './schemas/cart.schema';
import { CartState } from './schemas/cart-state.schema';

// Giỏ tối đa 100 dòng nên mỗi truy vấn chỉ vài trăm document. Lô đầu đủ lớn để server trả hết một lần:
// trong transaction có timeoutMS, driver MongoDB báo lỗi nếu cursor phải gọi getMore lấy lô tiếp.
const READ_BATCH = 1000;

@Injectable()
export class CartRepository {
  constructor(
    @InjectModel('Cart') private readonly carts: Model<CartLine>,
    @InjectModel('CartState') private readonly states: Model<CartState>,
    @InjectConnection() private readonly connection: Connection,
  ) {}

  // ---------- Đọc giỏ ----------

  // null = Member chưa có state (chưa từng ghi giỏ thành công) → coi như version 0.
  async findVersion(memberId: Types.ObjectId, session: ClientSession): Promise<number | null> {
    const state = await this.states.findById(memberId, { version: 1 }).session(session).lean();
    return state ? state.version : null;
  }

  // US-40-TC01: dòng theo thứ tự thêm (created_at rồi _id), dùng index (member_id, created_at, _id).
  findLines(memberId: Types.ObjectId, session: ClientSession): Promise<CartLineRow[]> {
    return this.carts.find({ member_id: memberId }, { _id: 1, product_id: 1, quantity: 1 })
      .sort({ created_at: 1, _id: 1 }).batchSize(READ_BATCH).session(session).lean<CartLineRow[]>();
  }

  // ---------- Đọc catalog (chỉ đọc, không đổi tồn – US-40-F03) ----------

  // Chỉ lấy field giỏ cần; không lấy giá vốn hay field quản trị.
  findProducts(ids: Types.ObjectId[], session: ClientSession): Promise<CartProductRow[]> {
    return this.connection.db!.collection('products').find<CartProductRow>({ _id: { $in: ids } }, {
      projection: { _id: 1, category_id: 1, sku: 1, name: 1, image_url: 1, price: 1, status: 1, version: 1 }, batchSize: READ_BATCH, session,
    }).toArray();
  }

  findCategories(ids: Types.ObjectId[], session: ClientSession): Promise<CartCategoryRow[]> {
    return this.connection.db!.collection('categories').find<CartCategoryRow>({ _id: { $in: ids } }, {
      projection: { _id: 1, status: 1 }, batchSize: READ_BATCH, session,
    }).toArray();
  }

  // Chỉ lấy on_hand/reserved để tính available; không lấy unit_cost (US-40-TC07).
  findInventories(productIds: Types.ObjectId[], session: ClientSession): Promise<CartInventoryRow[]> {
    return this.connection.db!.collection('inventory').find<CartInventoryRow>({ product_id: { $in: productIds } }, {
      projection: { _id: 0, product_id: 1, on_hand: 1, reserved: 1 }, batchSize: READ_BATCH, session,
    }).toArray();
  }

  // ---------- Ghi giỏ (luôn trong transaction) ----------

  // US-40-C01: state chưa có và client gửi version 0 → tạo state version 1 (lazy, chỉ trong mutation thành công).
  async createState(memberId: Types.ObjectId, session: ClientSession): Promise<void> {
    await this.states.create([{ _id: memberId, version: 1 }], { session });
  }

  // US-40-C01: CAS – chỉ tăng khi version trong DB đúng bằng version đã kiểm. Trả false nếu không khớp.
  async increaseVersion(memberId: Types.ObjectId, expected: number, session: ClientSession): Promise<boolean> {
    const result = await this.states.updateOne({ _id: memberId, version: expected }, { $set: { version: expected + 1 } }, { session });
    return result.modifiedCount === 1;
  }

  // Thêm dòng mới hoặc đặt lại số lượng dòng đã có. Unique (member_id, product_id) bảo đảm một dòng mỗi SKU.
  async saveLine(memberId: Types.ObjectId, productId: Types.ObjectId, quantity: number, session: ClientSession): Promise<void> {
    await this.carts.updateOne({ member_id: memberId, product_id: productId }, { $set: { quantity } },
      { upsert: true, runValidators: true, session });
  }

  async deleteLine(memberId: Types.ObjectId, productId: Types.ObjectId, session: ClientSession): Promise<void> {
    await this.carts.deleteOne({ member_id: memberId, product_id: productId }, { session });
  }
}
