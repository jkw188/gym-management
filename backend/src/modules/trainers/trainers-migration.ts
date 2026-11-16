import { Int32, ObjectId } from 'mongodb';
import { Connection } from 'mongoose';
import { TrainerSchema } from './schemas/trainer.schema';
import { TrainerEventSchema } from './schemas/trainer-event.schema';

// Run with schedule/profile writers stopped. Preflight every old profile before any backfill.
// Never invent a creator or move historical schedules to a different person.
export async function ensureTrainersIntegrity(connection: Connection): Promise<void> {
  const trainers = connection.db!.collection('trainers');
  const seen = new Set<string>();
  for await (const row of trainers.find({})) {
    const invalid = () => new Error(`TRAINER_DATA_INVALID: profile/${row._id}`);
    if (!(row.account_id instanceof ObjectId) || seen.has(row.account_id.toHexString())) throw invalid();
    seen.add(row.account_id.toHexString());
    if (typeof row.specialty !== 'string' || !row.specialty.trim() || row.specialty.length > 255 || row.specialty !== row.specialty.trim() ||
      !['ACTIVE', 'INACTIVE'].includes(row.status) ||
      row.version !== undefined && (typeof row.version !== 'number' || !Number.isInteger(row.version) || row.version < 0 || row.version > 2147483647) ||
      row.id !== undefined && (!(row.id instanceof ObjectId) || !row.id.equals(row._id)) ||
      !(row.created_at instanceof Date) || !(row.updated_at instanceof Date) ||
      !(row.created_by instanceof ObjectId) || !(row.updated_by instanceof ObjectId)) throw invalid();
    if (!await connection.db!.collection('accounts').findOne({ _id: row.account_id }, { projection: { _id: 1 } })) throw invalid();
  }
  await connection.model('Trainer', TrainerSchema).createIndexes();
  await connection.model('TrainerEvent', TrainerEventSchema).createIndexes();
  await trainers.updateMany({ version: { $exists: false } }, { $set: { version: new Int32(0) } });
  await trainers.updateMany({ version: { $exists: true }, $expr: { $ne: [{ $type: '$version' }, 'int'] } },
    [{ $set: { version: { $toInt: '$version' } } }]);
  await trainers.updateMany({ id: { $exists: false } }, [{ $set: { id: '$_id' } }]);
}
