import { Connection } from 'mongoose';

// Chỉ index phục vụ tra cứu; các unique constraint do EN-02 quản lý riêng.
export async function ensureMembersQueryIndexes(connection: Connection): Promise<void> {
  await connection.collection('service_sales').createIndex({ member_id: 1, transaction_id: 1 }, { name: 'service_sales_member_transaction' });
  await connection.collection('transactions').createIndex({ member_id: 1, created_at: -1, _id: -1 }, { name: 'transactions_member_created_desc' });
}
