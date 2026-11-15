import { Connection } from 'mongoose';
import { overlaps } from '../scheduling/interval.policy';
import { ShiftIntervalService } from '../shifts/shift-interval.service';
import { sessionDraft } from './public-session.policy';
import { PublicSessionSchema } from './schemas/public-session.schema';
import { PublicSessionEventSchema } from './schemas/public-session-event.schema';

// Chạy khi dừng writers. Kiểm toàn bộ trước khi backfill, không đoán actor/timestamp hoặc sửa lịch xung đột.
export async function ensurePublicSessionsIntegrity(connection: Connection) {
  const model = connection.models.PublicSession ?? connection.model('PublicSession', PublicSessionSchema);
  const rows = await connection.collection('public_sessions').find({}).toArray();
  const interval = new ShiftIntervalService();
  for (const row of rows) {
    try {
      if (row.version !== undefined && (!Number.isSafeInteger(row.version) || row.version < 0 || row.version >= Number.MAX_SAFE_INTEGER)) throw new Error('version');
      if (!(row.start_at instanceof Date) || !(row.end_at instanceof Date)) throw new Error('interval');
      const candidate = { ...row, id: row.id === undefined ? row._id : row.id,
        subject_code: row.subject_code === undefined ? 'OTHER' : row.subject_code, version: row.version === undefined ? 0 : row.version };
      await model.hydrate(candidate).validate();
      if (!(row.created_at instanceof Date) || !(row.updated_at instanceof Date)) throw new Error('timestamps');
      sessionDraft({ title: row.title, trainerId: String(row.trainer_id), subjectCode: candidate.subject_code,
        location: row.location, startAt: row.start_at.toISOString(), endAt: row.end_at.toISOString() }, interval);
    } catch { throw new Error(`PUBLIC_SESSION_DATA_INVALID: invalid_session/${row._id}`); }
  }
  const published = rows.filter(row => row.status === 'PUBLISHED');
  const bookings = await connection.collection('pt_bookings').find({ status: { $in: ['BOOKED', 'COMPLETED'] } }).toArray();
  for (let i = 0; i < published.length; i++) {
    const row = published[i];
    for (const other of [...published.slice(i + 1), ...bookings]) {
      if (String(row.trainer_id) === String(other.trainer_id) && overlaps(
        { startAt: row.start_at, endAt: row.end_at }, { startAt: other.start_at, endAt: other.end_at })) {
        throw new Error(`PUBLIC_SESSION_DATA_INVALID: schedule_overlap/${row._id}`);
      }
    }
  }
  await connection.collection('public_sessions').updateMany({ subject_code: { $exists: false } }, { $set: { subject_code: 'OTHER' } });
  await connection.collection('public_sessions').updateMany({ version: { $exists: false } }, { $set: { version: 0 } });
  await connection.collection('public_sessions').updateMany({ id: { $exists: false } }, [{ $set: { id: '$_id' } }]);
  await model.createIndexes();
  await (connection.models.PublicSessionEvent ?? connection.model('PublicSessionEvent', PublicSessionEventSchema)).createIndexes();
}
