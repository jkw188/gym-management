import { ObjectId } from 'mongodb';
import { Connection } from 'mongoose';
import { DataGuardsService } from '../../infrastructure/transaction/data-guards.service';
import { TransactionRunner } from '../../infrastructure/transaction/transaction-runner';
import { AttendanceEventSchema, AttendanceSchema } from './attendance.schema';

// Run in a maintenance window before enabling attendance writers. No hours or historical audit are fabricated.
export async function ensureAttendanceIntegrity(connection: Connection): Promise<void> {
  const transactions = new TransactionRunner(connection);
  const guards = new DataGuardsService(connection);
  const noBackfill = new Error('ATTENDANCE_MIGRATION_NO_BACKFILL');
  // Writers are stopped for this operational migration. An empty collection needs indexes only,
  // preserving the EN01 ability to ensure indexes on a standalone DB before any feature data exists.
  const hasAttendance = await connection.db!.collection('trainer_attendance').findOne({}, { projection: { _id: 1 } });
  if (hasAttendance) await transactions.run(async session => {
    await guards.acquire(session, { schedule: true });
    const db = connection.db!;
    const rows = await db.collection('trainer_attendance').find({}, { session }).toArray();
    const shifts = new Set<string>();
    const changes: { id: ObjectId; fields: Record<string, unknown> }[] = [];
    const validDate = (value: unknown): value is Date => value instanceof Date && Number.isFinite(value.getTime());
    for (const row of rows) {
      const fail = () => { throw new Error(`ATTENDANCE_MIGRATION_REQUIRES_RECONCILIATION:${String(row._id)}`); };
      if (!(row.shift_id instanceof ObjectId) || shifts.has(String(row.shift_id))) fail();
      shifts.add(String(row.shift_id));
      const shift = await db.collection('work_shifts').findOne({ _id: row.shift_id }, { session });
      if (!shift || !(shift.trainer_id instanceof ObjectId) || !await db.collection('trainers').findOne({ _id: shift.trainer_id }, { session })) fail();
      if (row.trainer_id !== undefined && (!(row.trainer_id instanceof ObjectId) || !row.trainer_id.equals(shift!.trainer_id))) fail();
      if (!(row.recorded_by instanceof ObjectId) || !await db.collection('accounts').findOne({ _id: row.recorded_by }, { session })) fail();
      if (!validDate(row.check_in_at) || row.check_out_at != null && (!validDate(row.check_out_at) || row.check_out_at <= row.check_in_at)) fail();
      if (!validDate(row.created_at) || row.updated_at !== undefined && !validDate(row.updated_at)) fail();
      if (row.version !== undefined && (!Number.isSafeInteger(row.version) || row.version < 0)) fail();
      if (row.id !== undefined && (!(row.id instanceof ObjectId) || !row.id.equals(row._id))) fail();
      if (row.note !== undefined && (typeof row.note !== 'string' || row.note.length > 255)) fail();
      changes.push({ id: row._id, fields: {
        ...(row.id === undefined ? { id: row._id } : {}), ...(row.trainer_id === undefined ? { trainer_id: shift!.trainer_id } : {}),
        ...(row.version === undefined ? { version: 0 } : {}), ...(row.updated_at === undefined ? { updated_at: row.created_at } : {}),
      } });
    }
    // A validation-only rerun must not commit a schedule revision change. Keep the real guard
    // while checking the snapshot, then abort the transaction if there is nothing to backfill.
    if (changes.every(change => Object.keys(change.fields).length === 0)) throw noBackfill;
    // Validate the entire source before writing any backfill; transaction also rolls back later failures.
    for (const change of changes) if (Object.keys(change.fields).length) {
      await db.collection('trainer_attendance').updateOne({ _id: change.id }, { $set: change.fields }, { session });
    }
  }).catch((error: unknown) => { if (error !== noBackfill) throw error; });
  await connection.model('Attendance', AttendanceSchema).createIndexes();
  // Partial unique index preserves legacy audit without inventing operation IDs for old events.
  await connection.model('AttendanceEvent', AttendanceEventSchema).createIndexes();
}
