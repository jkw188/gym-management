import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { ObjectId } from 'mongodb';
import { TransactionRunner } from '../../infrastructure/transaction/transaction-runner';
import { ProductOptionsQueryDto } from '../stock/stock-receipts.dto';
import { literalStockQuery } from '../stock/stock.repository';
import { validBalance } from './inventory-writer';

interface OptionRow {
  _id: ObjectId; sku: string; name: string; status: string; category?: { status: string };
  inventory?: { on_hand: number; reserved: number; version: number };
}
@Injectable()
export class ProductOptionsService {
  constructor(@InjectConnection() private readonly connection: Connection, private readonly transactions: TransactionRunner) {}
  list(query: ProductOptionsQueryDto) {
    return this.transactions.run(async session => {
      const filter: Record<string, unknown> = {};
      if (query.q) filter.$or = ['sku', 'name'].map(field => ({ [field]: literalStockQuery(query.q!) }));
      if (query.categoryId) filter.category_id = new ObjectId(query.categoryId);
      const [page] = await this.connection.db!.collection('products').aggregate<{ items: OptionRow[]; total: { count: number }[] }>([
        { $match: filter }, { $sort: { name: 1, _id: 1 } }, { $facet: { total: [{ $count: 'count' }], items: [
          { $skip: (query.page - 1) * query.limit }, { $limit: query.limit },
          { $lookup: { from: 'categories', localField: 'category_id', foreignField: '_id', as: 'categories' } },
          { $lookup: { from: 'inventory', localField: '_id', foreignField: 'product_id', as: 'inventories' } },
          { $project: { sku: 1, name: 1, status: 1, category: { $arrayElemAt: ['$categories', 0] }, inventory: { $arrayElemAt: ['$inventories', 0] } } },
        ] } },
      ], { session }).toArray();
      const total = page.total[0]?.count ?? 0;
      return { items: page.items.map(row => ({ id: String(row._id), sku: row.sku, name: row.name, status: row.status,
        effectiveActive: row.status === 'ACTIVE' && row.category?.status === 'ACTIVE',
        inventoryState: !row.inventory ? 'MISSING' : validBalance(row.inventory) ? 'VALID' : 'INCONSISTENT' })),
        page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) };
    });
  }
}
