import { Decimal128, Int32, Long, ObjectId } from 'mongodb';
import { Connection } from 'mongoose';
import { fromVndDecimal } from '../../common/utils/vnd-money';
import { categoryKey, categoryName, retailSku, safeRetailImage } from './retail-catalog.policy';
import { RETAIL_MODELS } from './retail-catalog.schema';

// Maintenance command: stop all catalog/stock/cart writers first. Preflight all rows before backfilling.
// Missing inventory is deliberately blocked: absence alone cannot prove that no stock/history exists.
export async function ensureRetailCatalogIntegrity(connection: Connection): Promise<void> {
  await preflightRetailCatalog(connection);
  const db = connection.db!;
  for (const collection of ['categories', 'products']) {
    for await (const row of db.collection(collection).find({})) {
      const data: Record<string, unknown> = { id: row._id, version: new Int32(row.version ?? 0) };
      if (collection === 'categories') { data.name = categoryName(row.name); data.name_key = categoryKey(row.name); }
      else {
        data.name = row.name.trim(); data.sku = retailSku(row.sku);
        if (row.description !== undefined) data.description = row.description.trim();
        if (row.image_url !== undefined) data.image_url = row.image_url.trim();
      }
      await db.collection(collection).updateOne({ _id: row._id }, { $set: data });
    }
  }
  for await (const row of db.collection('inventory').find({}, { promoteLongs: false })) {
    await db.collection('inventory').updateOne({ _id: row._id }, { $set: {
      on_hand: new Int32(row.on_hand), reserved: new Int32(row.reserved), version: new Int32(row.version ?? 0),
      guard_revision: row.guard_revision === undefined ? Long.ZERO : Long.isLong(row.guard_revision) ? row.guard_revision : Long.fromNumber(row.guard_revision),
    } });
  }
  for (const { name, schema } of RETAIL_MODELS) await connection.model(name, schema).createIndexes();
  await db.collection<{ _id: string; revision: Long }>('catalog_state').updateOne({ _id: 'retail' },
    { $setOnInsert: { revision: Long.ZERO } }, { upsert: true });
}

export async function preflightRetailCatalog(connection: Connection): Promise<void> {
  const db = connection.db!, names = new Set<string>(), skus = new Set<string>(), categories = new Set<string>(), products = new Set<string>();
  const invalid = (kind: string, id: unknown) => new Error(`CATALOG_DATA_INVALID: ${kind}/${id}`);
  const validVersion = (value: unknown) => value === undefined || typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 2147483647;
  const common = (row: Record<string, unknown>) => row._id instanceof ObjectId &&
    (row.id === undefined || row.id instanceof ObjectId && row.id.equals(row._id)) &&
    typeof row.name === 'string' && row.name.trim().length > 0 && row.name.trim().length <= 120 &&
    ['ACTIVE', 'INACTIVE'].includes(String(row.status)) && validVersion(row.version) &&
    row.created_at instanceof Date && row.updated_at instanceof Date && row.created_by instanceof ObjectId && row.updated_by instanceof ObjectId;
  for await (const row of db.collection('categories').find({})) {
    if (!common(row)) throw invalid('category', row._id);
    const key = categoryKey(row.name as string);
    if (names.has(key) || row.name_key !== undefined && row.name_key !== key) throw invalid('category_name', row._id);
    names.add(key); categories.add(String(row._id));
  }
  for await (const row of db.collection('products').find({})) {
    if (!common(row) || !(row.category_id instanceof ObjectId) || !categories.has(String(row.category_id)) ||
      typeof row.sku !== 'string' || !/^[A-Z0-9_-]{1,40}$/.test(retailSku(row.sku)) || !(row.price instanceof Decimal128) ||
      row.description !== undefined && (typeof row.description !== 'string' || row.description.length > 2000) ||
      row.image_url !== undefined && (typeof row.image_url !== 'string' || !safeRetailImage(row.image_url.trim()))) throw invalid('product', row._id);
    try { fromVndDecimal(row.price); } catch { throw invalid('price', row._id); }
    const sku = retailSku(row.sku);
    if (skus.has(sku)) throw invalid('sku', row._id);
    skus.add(sku); products.add(String(row._id));
    if (await db.collection('inventory').countDocuments({ product_id: row._id }) !== 1) throw invalid('inventory_reconciliation', row._id);
  }
  const inventoryProducts = new Set<string>();
  for await (const row of db.collection('inventory').find({})) {
    if (!(row.product_id instanceof ObjectId) || !products.has(String(row.product_id)) || inventoryProducts.has(String(row.product_id)) ||
      !validVersion(row.on_hand) || row.on_hand === undefined || !validVersion(row.reserved) || row.reserved === undefined ||
      row.reserved > row.on_hand || !validVersion(row.version) || !(row.updated_at instanceof Date)) throw invalid('inventory', row._id);
    const revision = row.guard_revision;
    if (revision !== undefined && !(Long.isLong(revision) ? revision.gte(Long.ZERO) : typeof revision === 'number' && Number.isSafeInteger(revision) && revision >= 0)) throw invalid('inventory_revision', row._id);
    inventoryProducts.add(String(row.product_id));
  }
  const state = await db.collection<{ _id: string; revision: Long | number }>('catalog_state').findOne({ _id: 'retail' }, { promoteLongs: false });
  if (state && (!Long.isLong(state.revision) || state.revision.isNegative())) throw invalid('state', 'retail');
}
