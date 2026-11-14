import { Long } from 'mongodb';
import { Connection } from 'mongoose';

const REVISIONS = [['accounts', 'recovery_revision'], ['password_resets', 'recovery_revision_snapshot']] as const;

// Lệnh quản trị, chạy khi dừng writer. Giữ nguyên revision, timestamp và hiệu lực các flow hiện có.
export async function ensurePasswordResetRevisions(connection: Connection): Promise<void> {
  for (const [name, field] of REVISIONS) {
    const invalid = await connection.collection(name).findOne({ [field]: { $exists: true }, $expr: { $or: [
      { $not: [{ $in: [{ $type: `$${field}` }, ['int', 'long']] }] },
      { $lt: [`$${field}`, 0] },
    ] } }, { projection: { _id: 1 } });
    if (invalid) throw new Error(`US05_INVALID_REVISION: ${name}/${field}`);
  }
  await connection.collection('accounts').updateMany({ recovery_revision: { $exists: false } },
    { $set: { recovery_revision: Long.ZERO } });
  for (const [name, field] of REVISIONS) {
    await connection.collection(name).updateMany({ [field]: { $type: 'int' } },
      [{ $set: { [field]: { $toLong: `$${field}` } } }]);
  }
}
