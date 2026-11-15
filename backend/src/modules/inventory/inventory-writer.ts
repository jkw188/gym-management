import { Injectable } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ClientSession, Int32, Long, ObjectId } from 'mongodb';
import { Connection, Model } from 'mongoose';
import { ApplicationError } from '../../common/errors/application-error';
import { StockMovement } from '../stock/stock.schema';

export const STOCK_MAX = 2147483647;
export const inventoryIntegrityError = () => new ApplicationError(409, 'INVENTORY_INTEGRITY_ERROR', 'Số dư hoặc lịch sử kho cần được đối chiếu trước khi ghi');
export const stockLimitError = () => new ApplicationError(409, 'STOCK_LIMIT_EXCEEDED', 'Số lượng hoặc sequence kho vượt giới hạn Int32');
export function validBalance(row: { on_hand: number; reserved: number; version: number } | null | undefined): boolean {
  return Boolean(row && [row.on_hand, row.reserved, row.version].every(n => Number.isInteger(n) && n >= 0 && n <= STOCK_MAX) && row.reserved <= row.on_hand);
}
export interface LockedBalance { product_id: ObjectId; on_hand: number; reserved: number; version: number }
type MovementInput = Omit<StockMovement, '_id' | 'sequence' | 'before_on_hand' | 'before_reserved' | 'after_on_hand' | 'after_reserved'>;

@Injectable()
export class InventoryWriter {
  constructor(@InjectConnection() private readonly connection: Connection, @InjectModel('StockMovement') private readonly movements: Model<StockMovement>) {}

  // S05-I01: take real Int64 write locks in productId order, before reading balances or taking document CAS.
  async lock(productIds: string[], session: ClientSession): Promise<Map<string, LockedBalance>> {
    if (!session.inTransaction()) throw new Error('INVENTORY_TRANSACTION_REQUIRED');
    const inventory = this.connection.db!.collection<LockedBalance & { guard_revision: Long }>('inventory');
    const balances = new Map<string, LockedBalance>();
    for (const id of [...new Set(productIds)].sort()) {
      const result = await inventory.updateOne({ product_id: new ObjectId(id), guard_revision: { $type: 'long', $gte: Long.ZERO, $lt: Long.MAX_VALUE },
        on_hand: { $type: 'int' }, reserved: { $type: 'int' }, version: { $type: 'int' } }, { $inc: { guard_revision: Long.ONE } }, { session });
      if (result.modifiedCount !== 1) throw inventoryIntegrityError();
      const balance = await inventory.findOne({ product_id: new ObjectId(id) }, { session });
      if (!validBalance(balance)) throw inventoryIntegrityError();
      balances.set(id, balance!);
    }
    return balances;
  }

  check(balance: LockedBalance, handDelta: number, reservedDelta: number) {
    if (!validBalance(balance) || ![handDelta, reservedDelta].every(n => Number.isInteger(n) && Math.abs(n) <= STOCK_MAX)) throw inventoryIntegrityError();
    if (balance.version === STOCK_MAX || balance.on_hand + handDelta > STOCK_MAX || balance.reserved + reservedDelta > STOCK_MAX) throw stockLimitError();
    if (balance.reserved + reservedDelta < 0 || balance.on_hand + handDelta < balance.reserved + reservedDelta) throw inventoryIntegrityError();
  }

  async apply(balance: LockedBalance, input: MovementInput, session: ClientSession): Promise<string> {
    if (!session.inTransaction()) throw new Error('INVENTORY_TRANSACTION_REQUIRED');
    this.check(balance, input.on_hand_delta, input.reserved_delta);
    if (input.on_hand_delta === 0 && input.reserved_delta === 0) throw inventoryIntegrityError();
    const afterHand = balance.on_hand + input.on_hand_delta, afterReserved = balance.reserved + input.reserved_delta, sequence = balance.version + 1;
    const result = await this.connection.db!.collection('inventory').updateOne({ product_id: balance.product_id,
      on_hand: balance.on_hand, reserved: balance.reserved, version: balance.version }, { $set: {
      on_hand: new Int32(afterHand), reserved: new Int32(afterReserved), version: new Int32(sequence), updated_at: input.created_at,
    } }, { session });
    if (result.modifiedCount !== 1) throw inventoryIntegrityError();
    const id = await this.insertMovement({ ...input, sequence, before_on_hand: balance.on_hand, before_reserved: balance.reserved,
      after_on_hand: afterHand, after_reserved: afterReserved }, session);
    balance.on_hand = afterHand; balance.reserved = afterReserved; balance.version = sequence;
    return id;
  }
  async insertMovement(input: Omit<StockMovement, '_id'>, session: ClientSession) {
    const [movement] = await this.movements.create([input], { session }); return String(movement._id);
  }
}
