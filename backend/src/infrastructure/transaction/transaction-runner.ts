// Tầng hạ tầng (EN-02 bước 1): chạy một đơn vị công việc trong MỘT transaction MongoDB.
// Mọi lệnh ghi trong work phải dùng session được truyền vào; lỗi thì tất cả cùng rollback.
import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { ClientSession, MongoError, MongoOperationTimeoutError, TransactionOptions } from 'mongodb';
import { Connection } from 'mongoose';
import { ApplicationError } from '../../common/errors/application-error';
import { supportsTransactions } from '../environment/environment-check';

// EN-02-F03: driver chỉ được retry lỗi tạm thời trong tối đa 10 giây.
const TRANSACTION_DEADLINE_MS = 10_000;

// EN-02-F03: đọc snapshot, ghi majority, chỉ đọc từ primary.
const TRANSACTION_OPTIONS: TransactionOptions = {
  readConcern: { level: 'snapshot' },
  writeConcern: { w: 'majority' },
  readPreference: 'primary',
};

@Injectable()
export class TransactionRunner {
  // null = chưa kiểm tra MongoDB có hỗ trợ transaction hay không.
  private transactionsSupported: boolean | null = null;

  constructor(@InjectConnection() private readonly connection: Connection) {}

  // Chạy work trong transaction. work có thể bị driver chạy lại khi gặp lỗi tạm thời,
  // nên trong work KHÔNG gửi email, socket, HTTP ra ngoài và KHÔNG dùng Promise.all với cùng session.
  async run<T>(work: (session: ClientSession) => Promise<T>): Promise<T> {
    // EN-02-TC02: standalone không có transaction thì từ chối luôn, không chạy work theo kiểu nhiều lệnh ghi rời.
    await this.ensureTransactionsSupported();

    const session = await this.connection.startSession();
    try {
      // EN-02-TC01: withTransaction tự commit khi work xong, tự abort (rollback) khi work ném lỗi.
      // EN-02-TC03: driver tự chạy lại khi lỗi có nhãn TransientTransactionError/UnknownTransactionCommitResult;
      // lỗi nghiệp vụ (ApplicationError) không có nhãn nên được ném ra ngay, không retry.
      return await session.withTransaction(() => work(session), { ...TRANSACTION_OPTIONS, timeoutMS: TRANSACTION_DEADLINE_MS });
    } catch (error) {
      // EN-02-TC03: hết hạn mà vẫn không biết commit thành công hay chưa thì báo 503, client giữ nguyên key để hỏi lại.
      if (isOutcomeUnknown(error)) {
        throw new ApplicationError(503, 'OPERATION_OUTCOME_UNKNOWN', 'Chưa xác định được kết quả thao tác. Vui lòng kiểm tra lại sau');
      }
      throw error;
    } finally {
      // EN-02-TC01: luôn đóng session, kể cả khi lỗi, để không rò kết nối.
      await session.endSession();
    }
  }

  // Chỉ hỏi server một lần rồi nhớ kết quả.
  private async ensureTransactionsSupported(): Promise<void> {
    if (this.transactionsSupported === null) {
      this.transactionsSupported = await supportsTransactions(this.connection);
    }
    if (!this.transactionsSupported) {
      throw new ApplicationError(503, 'TRANSACTIONS_NOT_SUPPORTED', 'MongoDB phải chạy replica set để dùng transaction');
    }
  }
}

// Lỗi commit chưa rõ kết quả: driver gắn nhãn UnknownTransactionCommitResult,
// hoặc hết hạn 10 giây trong lúc đang retry (MongoOperationTimeoutError).
function isOutcomeUnknown(error: unknown): boolean {
  if (error instanceof MongoOperationTimeoutError) return true;
  return error instanceof MongoError && error.hasErrorLabel('UnknownTransactionCommitResult');
}
