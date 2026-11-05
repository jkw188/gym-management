// Tầng dữ liệu (EN-02 bước 3): nơi duy nhất đọc/ghi collection operation_requests.
// Ghi luôn nhận session rõ ràng để nằm trong transaction của lệnh nghiệp vụ; repository không tự mở transaction.
import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model, Types } from 'mongoose';
import { Operation, OperationRequest } from './schemas/operation-request.schema';

export interface NewOperationRequest {
  actorId: Types.ObjectId; operation: Operation; clientKey: string; requestHash: string;
  resultIds: Record<string, unknown>; responseStatus: number; responseBody: Record<string, unknown>; committedAt: Date;
}

@Injectable()
export class OperationRequestsRepository implements OnModuleInit {
  constructor(@InjectModel('OperationRequest') private readonly requests: Model<OperationRequest>,
    private readonly config: ConfigService) {}

  // Dev/test tự tạo index; production chỉ kiểm tra index đã có (giống các repository khác).
  async onModuleInit(): Promise<void> {
    if (this.config.get('nodeEnv') !== 'production') await this.requests.createIndexes();
    const actual = await this.requests.collection.listIndexes().toArray();
    for (const [key, options] of this.requests.schema.indexes()) {
      const found = actual.some(index => JSON.stringify(index.key) === JSON.stringify(key) && Boolean(index.unique) === Boolean(options.unique));
      if (!found) throw new Error('DATABASE_INDEXES_REQUIRED: run npm run ensure-indexes');
    }
  }

  // Không truyền session thì đọc dữ liệu đã commit (API lookup).
  findByKey(actorId: Types.ObjectId, operation: Operation, clientKey: string, session?: ClientSession) {
    return this.requests.findOne({ actor_id: actorId, operation, client_key: clientKey })
      .session(session ?? null).maxTimeMS(5000).lean().exec();
  }

  // EN-02-D01: chỉ insert trong transaction của lệnh, nên lệnh lỗi rollback thì cũng không còn record.
  async insert(record: NewOperationRequest, session: ClientSession): Promise<void> {
    await this.requests.create([{
      actor_id: record.actorId, operation: record.operation, client_key: record.clientKey, request_hash: record.requestHash,
      result_ids: record.resultIds, response_status: record.responseStatus, response_body: record.responseBody,
      committed_at: record.committedAt,
    }], { session });
  }
}
