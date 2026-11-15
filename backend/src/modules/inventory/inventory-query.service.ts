import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { ClientSession, Document, Filter, ObjectId } from 'mongodb';
import { Connection } from 'mongoose';
import { ApplicationError } from '../../common/errors/application-error';
import { addCalendarDays, assertBusinessDate, ServerClock } from '../../common/utils/business-date';
import { validateObjectId } from '../../common/utils/normalization';
import { TransactionRunner } from '../../infrastructure/transaction/transaction-runner';
import { literalStockQuery } from '../stock/stock.repository';
import { StockMovement } from '../stock/stock.schema';
import { InventoryQueryDto, MovementQueryDto, MovementResponseDto } from './inventory.dto';
import { validBalance } from './inventory-writer';

interface InventoryRow {
  _id: ObjectId; category_id: ObjectId; sku: string; name: string; status: string;
  category?: { status: string }; inventory?: { on_hand: number; reserved: number; version: number };
}
const missing = () => new ApplicationError(404, 'NOT_FOUND', 'Không tìm thấy sản phẩm hoặc biến động kho');
const idOf = (id: string) => new ObjectId(validateObjectId(id));
const finiteValue = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null;
@Injectable()
export class InventoryQueryService {
  constructor(@InjectConnection() private readonly connection: Connection, private readonly transactions: TransactionRunner, private readonly clock: ServerClock) {}
  private products<T extends Document = InventoryRow>(filter: Document, session: ClientSession, extra: Document[] = []) {
    return this.connection.db!.collection('products').aggregate<T>([
      { $match: filter },
      { $lookup: { from: 'categories', localField: 'category_id', foreignField: '_id', as: 'categories' } },
      { $lookup: { from: 'inventory', localField: '_id', foreignField: 'product_id', as: 'inventories' } },
      { $project: { category_id: 1, sku: 1, name: 1, status: 1, category: { $arrayElemAt: ['$categories', 0] }, inventory: { $arrayElemAt: ['$inventories', 0] } } },
      ...extra,
    ], { session });
  }
  private balance(row: InventoryRow, asOf: string) {
    const valid = validBalance(row.inventory);
    return { productId: String(row._id), categoryId: String(row.category_id), sku: row.sku, name: row.name, productStatus: row.status,
      effectiveActive: row.status === 'ACTIVE' && row.category?.status === 'ACTIVE',
      inventoryState: !row.inventory ? 'MISSING' : valid ? 'VALID' : 'INCONSISTENT',
      onHand: finiteValue(row.inventory?.on_hand), reserved: finiteValue(row.inventory?.reserved),
      available: valid ? row.inventory!.on_hand - row.inventory!.reserved : null, version: finiteValue(row.inventory?.version), asOf };
  }
  list(query: InventoryQueryDto) {
    return this.transactions.run(async session => {
      const asOf = this.clock.now().toISOString(), filter: Document = {};
      if (query.q) filter.$or = ['sku', 'name'].map(field => ({ [field]: literalStockQuery(query.q!) }));
      if (query.categoryId) filter.category_id = idOf(query.categoryId);
      if (query.productStatus) filter.status = query.productStatus;
      // The same validity predicate is evaluated by Mongo before both count and pagination.
      const numeric = ['on_hand', 'reserved', 'version'].map(field => ({ $and: [
        { $in: [{ $type: `$inventory.${field}` }, ['int', 'long', 'double']] },
        { $gte: [`$inventory.${field}`, 0] }, { $lte: [`$inventory.${field}`, 2147483647] },
        { $eq: [`$inventory.${field}`, { $trunc: { $convert: { input: `$inventory.${field}`, to: 'double', onError: -1, onNull: -1 } } }] },
      ] }));
      const valid = { $and: [...numeric, { $lte: ['$inventory.reserved', '$inventory.on_hand'] }] };
      const pipeline: Document[] = [{ $set: { valid } }];
      if (query.stockState === 'ERROR') pipeline.push({ $match: { valid: false } });
      if (query.stockState === 'IN_STOCK' || query.stockState === 'OUT_OF_STOCK') pipeline.push({ $match: { valid: true, $expr:
        query.stockState === 'IN_STOCK' ? { $gt: ['$inventory.on_hand', '$inventory.reserved'] } : { $eq: ['$inventory.on_hand', '$inventory.reserved'] } } });
      pipeline.push({ $sort: { name: 1, _id: 1 } }, { $facet: { total: [{ $count: 'count' }], items: [{ $skip: (query.page - 1) * query.limit }, { $limit: query.limit }] } });
      const [result] = await this.products<{ items: InventoryRow[]; total: { count: number }[] }>(filter, session, pipeline).toArray();
      const total = result.total[0]?.count ?? 0;
      return { items: result.items.map(row => this.balance(row, asOf)), page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit), asOf };
    });
  }
  detail(id: string) {
    const productId = idOf(id);
    return this.transactions.run(async session => {
      const asOf = this.clock.now().toISOString(), row = await this.products({ _id: productId }, session).next();
      if (!row) throw missing();
      return this.balance(row, asOf);
    });
  }
  history(id: string, query: MovementQueryDto) {
    const productId = idOf(id), toDate = assertBusinessDate(query.toDate ?? this.clock.today());
    const fromDate = assertBusinessDate(query.fromDate ?? addCalendarDays(toDate, -29));
    const days = (Date.parse(`${toDate}T00:00:00Z`) - Date.parse(`${fromDate}T00:00:00Z`)) / 86400000 + 1;
    if (days < 1 || days > 366) throw new ApplicationError(400, 'VALIDATION_ERROR', 'Khoảng ngày phải từ 1 đến 366 ngày');
    return this.transactions.run(async session => {
      const asOf = this.clock.now().toISOString();
      if (!await this.connection.db!.collection('products').findOne({ _id: productId }, { session, projection: { _id: 1 } })) throw missing();
      const filter: Filter<StockMovement> = { product_id: productId, created_at: {
        $gte: new Date(`${fromDate}T00:00:00+07:00`), $lt: new Date(`${addCalendarDays(toDate, 1)}T00:00:00+07:00`),
      } };
      if (query.kind) filter.kind = query.kind;
      const collection = this.connection.db!.collection<StockMovement>('stock_movements');
      const total = await collection.countDocuments(filter, { session });
      const rows = await collection.find(filter, { session }).sort({ sequence: 1 }).skip((query.page - 1) * query.limit).limit(query.limit).toArray();
      const items = [];
      for (const row of rows) items.push(await this.movement(row, session, asOf));
      return { items, page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit), range: { fromDate, toDate, timeZone: 'Asia/Ho_Chi_Minh' }, asOf };
    });
  }
  movementDetail(id: string) {
    const movementId = idOf(id);
    return this.transactions.run(async session => {
      const asOf = this.clock.now().toISOString();
      const row = await this.connection.db!.collection<StockMovement>('stock_movements').findOne({ _id: movementId }, { session });
      if (!row) throw missing();
      return this.movement(row, session, asOf);
    });
  }
  private async movement(row: StockMovement, session: ClientSession, asOf: string): Promise<MovementResponseDto> {
    let sourceType = row.source_type ?? 'UNKNOWN', sourceCode = row.source_code ?? null, sourcePath: string | null = null;
    // Only a committed receipt with the persisted line chain may supply a receipt link.
    if (row.kind === 'RECEIPT_POST' && row.document_item_id) {
      const item = await this.connection.db!.collection('stock_document_items').findOne({ _id: row.document_item_id, document_id: row.source_id, product_id: row.product_id }, { session, projection: { _id: 1 } });
      const source = item && await this.connection.db!.collection('stock_documents').findOne({ _id: row.source_id, kind: 'RECEIPT', status: 'POSTED' }, { session, projection: { code: 1 } });
      sourceType = 'STOCK_RECEIPT';
      if (source) { sourceCode ??= source.code as string; sourcePath = `/stock-receipts/${row.source_id}`; }
    }
    return { id: String(row._id), productId: String(row.product_id), sequence: row.sequence, kind: row.kind,
      skuSnapshot: row.sku_snapshot, nameSnapshot: row.name_snapshot, onHandDelta: row.on_hand_delta, reservedDelta: row.reserved_delta,
      beforeOnHand: row.before_on_hand, beforeReserved: row.before_reserved, afterOnHand: row.after_on_hand, afterReserved: row.after_reserved,
      createdAt: row.created_at.toISOString(), sourceType, sourceId: String(row.source_id), sourceCode, sourcePath, asOf };
  }
}
