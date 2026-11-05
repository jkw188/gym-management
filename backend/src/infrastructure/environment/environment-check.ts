// Tầng hạ tầng (EN-02 bước 2): kiểm tra MongoDB có đủ điều kiện cho giao dịch trước khi nghiệm thu.
// Chỉ đọc: thiếu điều kiện thì báo lỗi, KHÔNG tự tạo index hay ghi dữ liệu để "chữa".
import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { MongoServerError } from 'mongodb';
import { Connection } from 'mongoose';

// Unique index bắt buộc của operation_requests (EN-02-D01).
const REQUIRED_OPERATION_KEY = { actor_id: 1, operation: 1, client_key: 1 };

// MongoDB chỉ có transaction khi chạy replica set (có setName) hoặc qua mongos (msg = 'isdbgrid').
export async function supportsTransactions(connection: Connection): Promise<boolean> {
  const hello = await connection.db!.admin().command({ hello: 1 });
  return typeof hello.setName === 'string' || hello.msg === 'isdbgrid';
}

@Injectable()
export class EnvironmentCheck {
  constructor(@InjectConnection() private readonly connection: Connection) {}

  // Ném lỗi nếu môi trường chưa đủ điều kiện; đủ thì kết thúc bình thường.
  async assertReady(): Promise<void> {
    // EN-02-TC02: standalone không có transaction thì không đủ điều kiện.
    if (!(await supportsTransactions(this.connection))) {
      throw new Error('ENVIRONMENT_NOT_READY: MongoDB phải chạy replica set để dùng transaction');
    }
    // EN-02-TC02: thiếu unique index (actor_id, operation, client_key) thì không đủ điều kiện.
    if (!(await this.hasOperationRequestIndex())) {
      throw new Error('ENVIRONMENT_NOT_READY: thiếu unique index operation_requests, chạy npm run ensure-indexes');
    }
  }

  private async hasOperationRequestIndex(): Promise<boolean> {
    let indexes;
    try {
      indexes = await this.connection.collection('operation_requests').listIndexes().toArray();
    } catch (error) {
      // Mã 26 (NamespaceNotFound): collection chưa tồn tại thì chắc chắn chưa có index. Lỗi khác (mất kết nối...) ném nguyên.
      if (error instanceof MongoServerError && error.code === 26) return false;
      throw error;
    }
    // Phải đúng ba trường theo đúng thứ tự và phải unique.
    return indexes.some(index =>
      JSON.stringify(index.key) === JSON.stringify(REQUIRED_OPERATION_KEY) && index.unique === true);
  }
}
