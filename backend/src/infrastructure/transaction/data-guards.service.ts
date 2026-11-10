// Tầng dữ liệu – hạ tầng transaction (EN-02, US-28 bước 1): lấy các khóa ghi (revision) trong transaction theo thứ tự cố định.
import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { ClientSession, Long, ObjectId } from 'mongodb';
import { Connection } from 'mongoose';
import { ApplicationError } from '../../common/errors/application-error';
import { ACCOUNT_ADMINISTRATION } from '../../modules/users/schemas/security-state.schema';

// US-28-G01: khóa ghi lịch dùng chung có đúng một document này; tạo bởi lệnh ensure-indexes.
export const SCHEDULE_GUARD_ID = 'global';

export interface DataGuardTargets {
  accountAdministration?: boolean;
  plans?: ObjectId[];
  // US-28-G01: writer lịch (đặt/hủy booking, ca, lớp, PT) lấy khóa global trước khi kiểm xung đột.
  schedule?: boolean;
  members?: ObjectId[];
  transactions?: ObjectId[];
}

@Injectable()
export class DataGuardsService {
  constructor(@InjectConnection() private readonly connection: Connection) {}

  // Supply ALL targets once per transaction callback, before reading protected business data.
  // A new invocation belongs inside every driver retry, never outside TransactionRunner.run().
  // US-28-G01: thứ tự cố định security_state → plans → schedule_guards → members → transactions, không quay lại khóa trước.
  async acquire(session: ClientSession, targets: DataGuardTargets): Promise<void> {
    if (!session.inTransaction()) throw new Error('DATA_GUARD_TRANSACTION_REQUIRED');
    if (targets.accountAdministration) {
      // The exact US-07/08 lock, not another mutex or a replacement administration document.
      const result = await this.connection.db!.collection<{ _id: string; revision: Long }>('security_state').updateOne(
        { _id: ACCOUNT_ADMINISTRATION, revision: { $type: 'long', $gte: Long.ZERO, $lt: Long.MAX_VALUE } },
        { $inc: { revision: Long.ONE } }, { session });
      if (result.modifiedCount !== 1) throw guardNotReady();
    }
    await this.bumpRevisions(session, 'plans', 'guard_revision', targets.plans);
    if (targets.schedule) {
      // US-28-G01: ghi tăng THẬT revision (không no-op). Hai transaction cùng ghi một document thì MongoDB báo
      // write conflict cho transaction đến sau, nó phải retry → các writer lịch được xếp hàng ngay trong DB.
      const result = await this.connection.db!.collection<{ _id: string; revision: Long }>('schedule_guards').updateOne(
        { _id: SCHEDULE_GUARD_ID, revision: { $type: 'long', $gte: Long.ZERO, $lt: Long.MAX_VALUE } },
        { $inc: { revision: Long.ONE } }, { session });
      // Chưa chạy ensure-indexes (không có guard) hoặc revision sai kiểu → báo chưa sẵn sàng, không tự tạo guard.
      if (result.modifiedCount !== 1) throw guardNotReady();
    }
    await this.bumpRevisions(session, 'members', 'service_revision', targets.members);
    await this.bumpRevisions(session, 'transactions', 'guard_revision', targets.transactions);
  }

  // Ghi tăng revision của từng document theo _id tăng dần (bỏ trùng) để mọi writer lấy khóa cùng một thứ tự.
  private async bumpRevisions(session: ClientSession, collection: string, field: string, ids: ObjectId[] | undefined): Promise<void> {
    const sorted = [...new Set((ids ?? []).map(id => id.toHexString()))].sort();
    for (const id of sorted) {
      const result = await this.connection.collection(collection).updateOne(
        { _id: new ObjectId(id), [field]: { $type: 'long', $gte: Long.ZERO, $lt: Long.MAX_VALUE } },
        { $inc: { [field]: Long.ONE } }, { session });
      if (result.modifiedCount !== 1) throw guardNotReady();
    }
  }
}

function guardNotReady() {
  return new ApplicationError(409, 'DATA_GUARD_NOT_READY', 'Dữ liệu không tồn tại hoặc revision chưa sẵn sàng. Cần kiểm tra migration EN-02');
}
