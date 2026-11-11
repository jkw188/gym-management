import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { ClientSession, Long, ObjectId } from 'mongodb';
import { Connection } from 'mongoose';
import { ApplicationError } from '../../common/errors/application-error';
import { ACCOUNT_ADMINISTRATION } from '../../modules/users/schemas/security-state.schema';

export interface DataGuardTargets {
  accountAdministration?: boolean;
  plans?: ObjectId[];
  members?: ObjectId[];
  transactions?: ObjectId[];
}

@Injectable()
export class DataGuardsService {
  constructor(@InjectConnection() private readonly connection: Connection) {}

  // Supply ALL targets once per transaction callback, before reading protected business data.
  // A new invocation belongs inside every driver retry, never outside TransactionRunner.run().
  async acquire(session: ClientSession, targets: DataGuardTargets): Promise<void> {
    if (!session.inTransaction()) throw new Error('DATA_GUARD_TRANSACTION_REQUIRED');
    if (targets.accountAdministration) {
      // The exact US-07/08 lock, not another mutex or a replacement administration document.
      const result = await this.connection.db!.collection<{ _id: string; revision: Long }>('security_state').updateOne(
        { _id: ACCOUNT_ADMINISTRATION, revision: { $type: 'long', $gte: Long.ZERO, $lt: Long.MAX_VALUE } },
        { $inc: { revision: Long.ONE } }, { session });
      if (result.modifiedCount !== 1) throw guardNotReady();
    }
    for (const [collection, field, ids] of [
      ['plans', 'guard_revision', targets.plans],
      ['members', 'service_revision', targets.members],
      ['transactions', 'guard_revision', targets.transactions],
    ] as const) {
      const sorted = [...new Set((ids ?? []).map(id => id.toHexString()))].sort();
      for (const id of sorted) {
        const result = await this.connection.collection(collection).updateOne(
          { _id: new ObjectId(id), [field]: { $type: 'long', $gte: Long.ZERO, $lt: Long.MAX_VALUE } },
          { $inc: { [field]: Long.ONE } }, { session });
        if (result.modifiedCount !== 1) throw guardNotReady();
      }
    }
  }
}

function guardNotReady() {
  return new ApplicationError(409, 'DATA_GUARD_NOT_READY', 'Dữ liệu không tồn tại hoặc revision chưa sẵn sàng. Cần kiểm tra migration EN-02');
}
