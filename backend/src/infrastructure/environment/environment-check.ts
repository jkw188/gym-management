import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, Types } from 'mongoose';
import { randomUUID } from 'node:crypto';
import { FINANCIAL_INDEXES, hasFinancialIndex } from '../transaction/financial-integrity';

export async function supportsTransactions(connection: Connection): Promise<boolean> {
  const hello = await connection.db!.admin().command({ hello: 1 });
  return typeof hello.setName === 'string' || hello.msg === 'isdbgrid';
}

@Injectable()
export class EnvironmentCheck {
  constructor(@InjectConnection() private readonly connection: Connection) {}

  // Never repairs indexes/data. The sole probe write is deliberately aborted after preflight passes.
  async assertReady(): Promise<void> {
    if (!(await supportsTransactions(this.connection))) {
      throw new Error('ENVIRONMENT_NOT_READY: MongoDB phải hỗ trợ transaction (replica set hoặc mongos)');
    }
    for (const { collection, index } of FINANCIAL_INDEXES) {
      if (!(await hasFinancialIndex(this.connection, collection, index))) {
        throw new Error(`ENVIRONMENT_NOT_READY: thiếu index hợp lệ ${collection}/${index.name}; chạy npm run ensure-indexes`);
      }
    }
    await this.probeRollback();
  }

  private async probeRollback(): Promise<void> {
    const session = await this.connection.startSession();
    const id = new Types.ObjectId();
    const rollback = new Error('EN02_ROLLBACK_PROBE');
    const collection = this.connection.collection('operation_requests');
    try {
      await session.withTransaction(async () => {
        await collection.insertOne({ _id: id, actor_id: new Types.ObjectId(), operation: 'MEMBER_CREATE',
          client_key: randomUUID(), request_hash: '0'.repeat(64), result_ids: {}, response_status: 200,
          response_body: {}, committed_at: new Date() }, { session });
        if (!await collection.findOne({ _id: id }, { session })) throw new Error('ENVIRONMENT_ROLLBACK_PROBE_FAILED');
        throw rollback;
      }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary', timeoutMS: 10000 });
    } catch (error) {
      if (error !== rollback) throw new Error('ENVIRONMENT_NOT_READY: transaction ghi/rollback không hoạt động');
    } finally {
      await session.endSession();
    }
    if (await collection.findOne({ _id: id })) throw new Error('ENVIRONMENT_NOT_READY: rollback để lại dữ liệu');
  }
}
