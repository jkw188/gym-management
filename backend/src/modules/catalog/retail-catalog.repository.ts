import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ClientSession } from 'mongodb';
import { Connection, Model, Types } from 'mongoose';
import { ApplicationError } from '../../common/errors/application-error';
import { RetailCategoryQueryDto, RetailProductQueryDto } from './retail-catalog.dto';
import { CatalogEvent, RetailCategory, RetailInventory, RetailProduct, RETAIL_MODELS } from './retail-catalog.schema';
import { preflightRetailCatalog } from './retail-catalog.migration';
import { OperationRequestSchema } from '../operations/schemas/operation-request.schema';

export interface ProductRow extends RetailProduct { category: RetailCategory }
const literal = (q: string) => new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
@Injectable()
export class RetailCatalogRepository implements OnModuleInit {
  constructor(@InjectModel('RetailCategory') readonly categories: Model<RetailCategory>,
    @InjectModel('RetailProduct') readonly products: Model<RetailProduct>,
    @InjectModel('RetailInventory') readonly inventory: Model<RetailInventory>,
    @InjectModel('CatalogEvent') readonly events: Model<CatalogEvent>,
    @InjectConnection() private readonly connection: Connection) {}

  async onModuleInit() { await preflightRetailCatalog(this.connection); }

  async assertWriterReady() {
    for (const { name, schema } of [...RETAIL_MODELS, { name: 'OperationRequest', schema: OperationRequestSchema }]) {
      const model = this.connection.models[name];
      const indexes = await model.collection.listIndexes().toArray().catch(() => []);
      if (indexes.some(index => index.expireAfterSeconds !== undefined)) {
        throw new ApplicationError(503, 'CATALOG_NOT_READY', 'Không được dùng TTL cho dữ liệu danh mục hoặc kết quả lệnh');
      }
      for (const [key, options] of schema.indexes()) {
        if (!indexes.some(index => JSON.stringify(index.key) === JSON.stringify(key) &&
          Boolean(index.unique) === Boolean(options.unique) && !index.sparse && !index.partialFilterExpression &&
          (!index.collation || index.collation.locale === 'simple'))) {
          throw new ApplicationError(503, 'CATALOG_NOT_READY', 'Cần đối chiếu dữ liệu và chạy npm run ensure-indexes trước khi ghi danh mục');
        }
      }
    }
  }
  async list(kind: 'CATEGORY' | 'PRODUCT', query: RetailCategoryQueryDto | RetailProductQueryDto) {
    const filter: Record<string, unknown> = {};
    if (query.status) filter.status = query.status;
    if (query.q) filter.$or = (kind === 'CATEGORY' ? ['name'] : ['name', 'sku']).map(field => ({ [field]: literal(query.q!) }));
    if ('categoryId' in query && query.categoryId) filter.category_id = new Types.ObjectId(query.categoryId);
    const joins = kind === 'PRODUCT' ? [
      { $lookup: { from: 'categories', localField: 'category_id', foreignField: '_id', as: 'category' } },
      { $unwind: '$category' },
    ] : [];
    const [page] = await this.connection.db!.collection(kind === 'CATEGORY' ? 'categories' : 'products')
      .aggregate<{ items: (RetailCategory | ProductRow)[]; total: { count: number }[] }>([
        { $match: filter }, ...joins, { $sort: { name: 1, _id: 1 } },
        { $facet: { items: [{ $skip: (query.page - 1) * query.limit }, { $limit: query.limit }], total: [{ $count: 'count' }] } },
      ], { maxTimeMS: 5000 }).toArray();
    return { items: page.items, total: page.total[0]?.count ?? 0 };
  }
  category(id: Types.ObjectId, session?: ClientSession) { return this.categories.findById(id).session(session ?? null).lean().exec(); }
  product(id: Types.ObjectId, session?: ClientSession) { return this.products.findById(id).session(session ?? null).lean().exec(); }
  activeCount(categoryId: Types.ObjectId, session?: ClientSession) {
    return this.products.countDocuments({ category_id: categoryId, status: 'ACTIVE' }).session(session ?? null).exec();
  }
  async insertInventory(productId: Types.ObjectId, session: ClientSession) {
    await this.inventory.create([{ product_id: productId, on_hand: 0, reserved: 0, version: 0, guard_revision: 0n, updated_at: new Date() }], { session });
  }
  async insertEvent(event: Omit<CatalogEvent, '_id'>, session: ClientSession) { await this.events.create([event], { session }); }
}
