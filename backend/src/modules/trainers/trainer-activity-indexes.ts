import { Connection } from 'mongoose';

// Operational setup only. No backfill, inferred hours or fabricated audit for US-63 data.
export async function ensureTrainerActivityIndexes(connection: Connection): Promise<void> {
  const db = connection.db!;
  await db.collection('trainer_attendance').createIndex({ shift_id: 1 }, { unique: true, name: 'trainer_attendance_shift_unique' });
  await db.collection('trainer_attendance').createIndex({ trainer_id: 1, check_in_at: 1 }, { name: 'trainer_attendance_trainer_in' });
  await db.collection('attendance_events').createIndex({ attendance_id: 1, occurred_at: 1 }, { name: 'attendance_events_attendance_time' });
  await db.collection('attendance_events').createIndex({ shift_id: 1, occurred_at: 1, _id: 1 }, { name: 'attendance_events_shift_time' });
}
