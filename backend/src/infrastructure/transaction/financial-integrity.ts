import { IndexDescription, Long, MongoServerError } from 'mongodb';
import { Connection } from 'mongoose';

// EN-02 owns these constraints; full document schemas and business state machines belong to their US.
export const FINANCIAL_INDEXES: { collection: string; index: IndexDescription }[] = [
  { collection: 'transactions', index: { key: { request_key: 1 }, unique: true, name: 'transactions_request_key_unique' } },
  { collection: 'service_sales', index: { key: { transaction_id: 1 }, unique: true, name: 'service_sales_transaction_unique' } },
  { collection: 'memberships', index: { key: { service_sale_id: 1 }, unique: true, name: 'memberships_sale_unique' } },
  { collection: 'invoices', index: { key: { transaction_id: 1 }, unique: true, name: 'invoices_transaction_unique' } },
  { collection: 'invoices', index: { key: { invoice_no: 1 }, unique: true, name: 'invoices_number_unique' } },
  { collection: 'payments', index: { key: { reference: 1 }, unique: true, name: 'payments_reference_unique' } },
  { collection: 'payments', index: { key: { transaction_id: 1 }, unique: true, name: 'payments_succeeded_transaction_unique',
    partialFilterExpression: { status: 'SUCCEEDED' } } },
  { collection: 'operation_requests', index: { key: { actor_id: 1, operation: 1, client_key: 1 }, unique: true,
    name: 'operation_requests_actor_operation_key_unique' } },
  { collection: 'notifications', index: { key: { event_key: 1 }, unique: true, name: 'notifications_event_key_unique' } },
];

const REVISIONS = [ ['plans', 'guard_revision'], ['members', 'service_revision'], ['transactions', 'guard_revision'] ] as const;

// Operational command only. Preflight every constraint before changing anything; never delete duplicates.
export async function ensureFinancialIntegrity(connection: Connection): Promise<void> {
  for (const { collection, index } of FINANCIAL_INDEXES) {
    const fields = Object.keys(index.key);
    const duplicates = connection.collection(collection).aggregate([
      { $match: index.partialFilterExpression ?? {} },
      { $group: { _id: Object.fromEntries(fields.map(field => [field,
        collection === 'operation_requests' && field === 'client_key' ? { $toLower: `$${field}` } : { $ifNull: [`$${field}`, null] }])), count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } }, { $limit: 1 },
    ], { collation: { locale: 'simple' } });
    try {
      if (await duplicates.hasNext()) throw new Error(`EN02_DUPLICATE_DATA: ${collection}/${index.name}`);
    } finally { await duplicates.close(); }
  }
  for (const [collection, field] of REVISIONS) {
    const invalid = await connection.collection(collection).findOne({ [field]: { $exists: true },
      $expr: { $or: [{ $ne: [{ $type: `$${field}` }, 'long'] }, { $lt: [`$${field}`, 0] }] } }, { projection: { _id: 1 } });
    if (invalid) throw new Error(`EN02_INVALID_REVISION: ${collection}/${field}`);
  }
  for (const { collection, index } of FINANCIAL_INDEXES) {
    // Existing compatible indexes may have another name. Never drop them or weaken their options.
    if (!(await hasFinancialIndex(connection, collection, index))) {
      await connection.collection(collection).createIndexes([{ ...index, collation: { locale: 'simple' } }]);
    }
    if (!(await hasFinancialIndex(connection, collection, index))) throw new Error(`EN02_INDEX_CONFLICT: ${collection}/${index.name}`);
  }
  for (const [collection, field] of REVISIONS) {
    await connection.collection(collection).updateMany({ [field]: { $exists: false } }, { $set: { [field]: Long.ZERO } });
  }
  // Migrate UUIDs accepted by previous versions; preflight above detects case-folding conflicts first.
  await connection.collection('operation_requests').updateMany({ client_key: { $type: 'string', $regex: '[A-F]' } },
    [{ $set: { client_key: { $toLower: '$client_key' } } }]);
}

export async function hasFinancialIndex(connection: Connection, collection: string, expected: IndexDescription): Promise<boolean> {
  try {
    const indexes = await connection.collection(collection).listIndexes().toArray();
    // Idempotency keys must never expire, including a separately declared TTL index.
    if (collection === 'operation_requests' && indexes.some(index => index.expireAfterSeconds !== undefined)) return false;
    return indexes.some(index => index.unique === true && !index.sparse && index.expireAfterSeconds === undefined &&
      (!index.collation || index.collation.locale === 'simple') &&
      JSON.stringify(index.key) === JSON.stringify(expected.key) &&
      JSON.stringify(index.partialFilterExpression) === JSON.stringify(expected.partialFilterExpression));
  } catch (error) {
    if (error instanceof MongoServerError && error.code === 26) return false;
    throw error;
  }
}
