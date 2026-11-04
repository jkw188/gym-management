// Tầng kiểm thử backend (Jest + MongoDB thật trong bộ nhớ): EN-02 bước 1 (TransactionRunner).
// Kiểm tra rollback (TC01), từ chối môi trường standalone (TC02), retry có giới hạn và lỗi commit chưa rõ (TC03).
import 'reflect-metadata';
import { ClientSession, MongoServerError } from 'mongodb';
import { MongoMemoryReplSet, MongoMemoryServer } from 'mongodb-memory-server';
import mongoose, { Connection } from 'mongoose';
import { ApplicationError } from '../src/common/errors/application-error';
// Hợp đồng test đặt ra cho Builder: class TransactionRunner có constructor(connection) và run(work(session)).
import { TransactionRunner } from '../src/infrastructure/transaction/transaction-runner';

const mongoBinary = { version: '8.0.17' };

// Tạo lỗi giống lỗi thật của driver, gắn nhãn để driver biết đây là lỗi tạm thời hay commit chưa rõ.
function labeledError(label: string): MongoServerError {
  const error = new MongoServerError({ message: `giả lập ${label}` });
  error.addErrorLabel(label);
  return error;
}

describe('EN-02 bước 1: TransactionRunner trên replica set', () => {
  let mongo: MongoMemoryReplSet;
  let connection: Connection;
  let runner: TransactionRunner;

  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({ binary: mongoBinary, replSet: { count: 1, storageEngine: 'wiredTiger', dbName: 'gym_management_test_en02' } });
    connection = await mongoose.createConnection(mongo.getUri(), { dbName: 'gym_management_test_en02' }).asPromise();
    runner = new TransactionRunner(connection);
  }, 600000);

  afterAll(async () => {
    await connection?.close();
    await mongo?.stop();
  });

  beforeEach(async () => {
    await connection.collection('payments').deleteMany({});
    await connection.collection('invoices').deleteMany({});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // EN-02-TC01: throw trước commit thì mọi thay đổi rollback, session được đóng.
  it('EN-02-TC01: throw trước commit thì ghi vào hai collection đều rollback', async () => {
    const boom = new Error('cố ý lỗi trước commit');
    await expect(runner.run(async (session) => {
      await connection.collection('payments').insertOne({ amount: 1000 }, { session });
      await connection.collection('invoices').insertOne({ invoiceNo: 'INV-1' }, { session });
      throw boom;
    })).rejects.toBe(boom);

    expect(await connection.collection('payments').countDocuments()).toBe(0);
    expect(await connection.collection('invoices').countDocuments()).toBe(0);
  });

  it('EN-02-TC01: sau khi rollback session đã được đóng (không rò kết nối)', async () => {
    let usedSession: ClientSession | undefined;
    await runner.run(async (session) => {
      usedSession = session;
      throw new Error('cố ý lỗi');
    }).catch(() => undefined);

    expect(usedSession).toBeDefined();
    expect(usedSession!.hasEnded).toBe(true);
  });

  it('EN-02-TC01: không lỗi thì commit, dữ liệu cả hai collection được lưu và session đóng', async () => {
    let usedSession: ClientSession | undefined;
    const result = await runner.run(async (session) => {
      usedSession = session;
      await connection.collection('payments').insertOne({ amount: 1000 }, { session });
      await connection.collection('invoices').insertOne({ invoiceNo: 'INV-1' }, { session });
      return 'xong';
    });

    expect(result).toBe('xong');
    expect(await connection.collection('payments').countDocuments()).toBe(1);
    expect(await connection.collection('invoices').countDocuments()).toBe(1);
    expect(usedSession!.hasEnded).toBe(true);
  });

  // EN-02-TC03: callback chạy lại khi lỗi tạm thời, nhưng không được để lại ghi của lần chạy hỏng.
  it('EN-02-TC03: lỗi TransientTransactionError thì chạy lại callback và chỉ commit một bản ghi', async () => {
    let attempts = 0;
    await runner.run(async (session) => {
      attempts += 1;
      await connection.collection('payments').insertOne({ amount: 1000, attempt: attempts }, { session });
      if (attempts === 1) throw labeledError('TransientTransactionError');
    });

    expect(attempts).toBe(2);
    const saved = await connection.collection('payments').find().toArray();
    expect(saved).toHaveLength(1);
    expect(saved[0].attempt).toBe(2);
  });

  it('EN-02-TC03: lỗi nghiệp vụ không bị retry, callback chạy đúng một lần và lỗi được ném nguyên vẹn', async () => {
    let attempts = 0;
    const businessError = new ApplicationError(409, 'IDEMPOTENCY_CONFLICT', 'Trùng khóa');
    await expect(runner.run(async () => {
      attempts += 1;
      throw businessError;
    })).rejects.toBe(businessError);

    expect(attempts).toBe(1);
  });

  // EN-02-F03: transaction phải dùng readConcern snapshot, writeConcern majority, readPreference primary.
  it('EN-02-TC03: transaction dùng readConcern snapshot, writeConcern majority, readPreference primary', async () => {
    let options: { readConcern?: { level?: string }; writeConcern?: { w?: unknown }; readPreference?: { mode?: string } } | undefined;
    await runner.run(async (session) => {
      options = session.transaction.options;
    });

    expect(options?.readConcern?.level).toBe('snapshot');
    expect(options?.writeConcern?.w).toBe('majority');
    expect(options?.readPreference?.mode).toBe('primary');
  });

  it('EN-02-TC03: lỗi commit chưa rõ kết quả vẫn đóng session', async () => {
    jest.spyOn(ClientSession.prototype, 'commitTransaction').mockRejectedValue(labeledError('UnknownTransactionCommitResult'));
    let usedSession: ClientSession | undefined;

    await runner.run(async (session) => {
      usedSession = session;
    }).catch(() => undefined);

    expect(usedSession!.hasEnded).toBe(true);
  }, 30000);

  it('EN-02-TC03: lỗi commit chưa rõ kết quả thì dừng trong hạn 10 giây và trả 503 OPERATION_OUTCOME_UNKNOWN', async () => {
    jest.spyOn(ClientSession.prototype, 'commitTransaction').mockRejectedValue(labeledError('UnknownTransactionCommitResult'));

    const startedAt = Date.now();
    const failure = await runner.run(async (session) => {
      await connection.collection('payments').insertOne({ amount: 1000 }, { session });
    }).then(() => undefined, (error: unknown) => error);

    expect(failure).toBeInstanceOf(ApplicationError);
    expect((failure as ApplicationError).status).toBe(503);
    expect((failure as ApplicationError).code).toBe('OPERATION_OUTCOME_UNKNOWN');
    // Hạn theo spec là 10 giây; cho dư 2 giây sai số của máy chạy test.
    expect(Date.now() - startedAt).toBeLessThan(12000);
  }, 30000);
});

describe('EN-02 bước 1: TransactionRunner trên MongoDB standalone', () => {
  let standalone: MongoMemoryServer;
  let connection: Connection;
  let runner: TransactionRunner;

  beforeAll(async () => {
    standalone = await MongoMemoryServer.create({ binary: mongoBinary });
    connection = await mongoose.createConnection(standalone.getUri(), { dbName: 'gym_management_test_en02_standalone' }).asPromise();
    runner = new TransactionRunner(connection);
  }, 600000);

  afterAll(async () => {
    await connection?.close();
    await standalone?.stop();
  });

  // EN-02-TC02: standalone không đủ điều kiện, không được tự chuyển sang nhiều lệnh ghi rời.
  it('EN-02-TC02: standalone bị từ chối, callback không được chạy và không có dữ liệu nào được ghi', async () => {
    const work = jest.fn(async () => {
      await connection.collection('payments').insertOne({ amount: 1000 });
    });

    await expect(runner.run(work)).rejects.toThrow();

    expect(work).not.toHaveBeenCalled();
    expect(await connection.collection('payments').countDocuments()).toBe(0);
  });
});
