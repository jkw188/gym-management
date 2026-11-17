import { IndexDescription, MongoServerError } from 'mongodb';
import { Connection } from 'mongoose';
import { ReminderOccurrenceSchema } from './reminder-occurrence.schema';

// Membership dates/owner được chuẩn hóa ở service_sales, không nhân bản lịch nghiệp vụ vào membership.
export const REMINDER_SOURCE_INDEXES: { collection: string; index: IndexDescription }[] = [
  { collection: 'service_sales', index: { key: { end_date: 1, member_id: 1, _id: 1 }, name: 'sales_reminder_end_member' } },
  { collection: 'pt_bookings', index: { key: { status: 1, start_at: 1, _id: 1, created_at: 1 }, name: 'bookings_reminder_status_start' } },
];

export async function ensureRemindersIntegrity(connection: Connection): Promise<void> {
  const occurrences = connection.models.ReminderOccurrence ?? connection.model('ReminderOccurrence', ReminderOccurrenceSchema);
  // Không xóa occurrence hoặc dùng TTL; unique index lỗi thì dừng để vận hành kiểm dữ liệu.
  if ((await occurrences.collection.listIndexes().toArray().catch((error: unknown) => {
    if (error instanceof MongoServerError && error.code === 26) return [];
    throw error;
  })).some(index => index.expireAfterSeconds !== undefined)) throw new Error('REMINDER_TTL_NOT_ALLOWED');
  await occurrences.createIndexes();
  for (const { collection, index } of REMINDER_SOURCE_INDEXES) await connection.collection(collection).createIndex(index.key, index);
}
