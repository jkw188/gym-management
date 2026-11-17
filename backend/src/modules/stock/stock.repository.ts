import { Injectable } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ClientSession, Filter, ObjectId } from 'mongodb';
import { Connection, Model, Types } from 'mongoose';
import { ApplicationError } from '../../common/errors/application-error';
import { RetailCategory, RetailProduct, RetailInventorySchema } from '../catalog/retail-catalog.schema';
import { OperationRequestSchema } from '../operations/schemas/operation-request.schema';
import { StockDocument, StockDocumentEvent, StockDocumentItem, StockMovement, STOCK_MODELS } from './stock.schema';

export const literalStockQuery = (q: string) => new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
@Injectable()
export class StockRepository {
  constructor(@InjectConnection() readonly connection: Connection,
    @InjectModel('StockDocument') readonly documents: Model<StockDocument>,
    @InjectModel('StockDocumentItem') readonly items: Model<StockDocumentItem>,
    @InjectModel('StockMovement') readonly movements: Model<StockMovement>,
    @InjectModel('StockDocumentEvent') readonly events: Model<StockDocumentEvent>) {}

  async assertWriterReady() {
    for (const { schema } of [...STOCK_MODELS, { schema: RetailInventorySchema }, { schema: OperationRequestSchema }]) {
      const indexes = await this.connection.db!.collection(schema.get('collection')!).listIndexes().toArray().catch(() => []);
      if (indexes.some(index => index.expireAfterSeconds !== undefined) || schema.indexes().some(([key, options]) => !indexes.some(index =>
        JSON.stringify(index.key) === JSON.stringify(key) && Boolean(index.unique) === Boolean(options.unique) && !index.sparse &&
        JSON.stringify(index.partialFilterExpression) === JSON.stringify(options.partialFilterExpression) && (!index.collation || index.collation.locale === 'simple')))) {
        throw new ApplicationError(503, 'STOCK_NOT_READY', 'Cần đối chiếu dữ liệu và chạy npm run ensure-indexes trước khi ghi kho');
      }
    }
  }
  document(id: Types.ObjectId, session: ClientSession, kind: StockDocument['kind'] = 'RECEIPT') {
    return this.connection.db!.collection<StockDocument>('stock_documents').findOne({ _id: id, kind }, { session });
  }
  lines(id: Types.ObjectId, session: ClientSession) {
    return this.connection.db!.collection<StockDocumentItem>('stock_document_items').find({ document_id: id }, { session }).sort({ _id: 1 }).toArray();
  }
  product(id: string, session: ClientSession) {
    return this.connection.db!.collection<RetailProduct>('products').findOne({ _id: new ObjectId(id) }, { session });
  }
  category(id: Types.ObjectId, session: ClientSession) {
    return this.connection.db!.collection<RetailCategory>('categories').findOne({ _id: id }, { session });
  }
  async movementIds(id: Types.ObjectId, session: ClientSession, kind = 'RECEIPT_POST') {
    return (await this.movements.find({ source_id: id, kind }).select('_id').sort({ document_item_id: 1 }).session(session).lean().exec()).map(row => String(row._id));
  }
  documentMovements(id: Types.ObjectId, session: ClientSession, kind = 'RECEIPT_POST') {
    return this.movements.find({ source_id: id, kind }).sort({ document_item_id: 1 }).session(session).lean().exec();
  }
  async page(filter: Filter<StockDocument>, page: number, limit: number, session: ClientSession) {
    const collection = this.connection.db!.collection<StockDocument>('stock_documents');
    const total = await collection.countDocuments(filter, { session });
    const items = await collection.find(filter, { session }).sort({ created_at: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).toArray();
    return { items, total, page, limit, totalPages: Math.ceil(total / limit) };
  }
  async insertEvent(event: Omit<StockDocumentEvent, '_id'>, session: ClientSession) { await this.events.create([event], { session }); }
  async replaceItems(id: Types.ObjectId, items: Omit<StockDocumentItem, '_id' | 'id'>[], session: ClientSession) {
    await this.items.deleteMany({ document_id: id }, { session });
    await this.items.create(items, { session, ordered: true });
  }
}
